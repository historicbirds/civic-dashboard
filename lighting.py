"""ATOTO CI-FLT01 control, using the observed LumiAuto ASCII protocol."""
import asyncio
import copy
import math
import os
import re
import threading
import time
from collections import deque

CHARACTERISTIC = '0000ffe1-0000-1000-8000-00805f9b34fb'
ADDRESS = re.compile(r'(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}')


def level(value):
    if type(value) is not int or not 0 <= value <= 9:
        raise ValueError('Brightness must be a whole level from 0 to 9.')
    return value


def color_frame(value):
    if not isinstance(value, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', value):
        raise ValueError('Choose a valid RGB color.')
    return ('AT+<06'+value[1:].upper()+'>0000FF1100001000800000805F9B34FB').encode('ascii')


def brightness_frame(zone, value):
    if zone not in ('front', 'rear'):
        raise ValueError('Unknown lighting zone.')
    return f'<010{1 if zone == "front" else 2}0{level(value)}>'.encode('ascii')


def settings(value):
    if not isinstance(value, dict) or not value or set(value)-{'color','power','front','rear','mode'}:
        raise ValueError('Unknown lighting setting.')
    result = dict(value)
    if 'color' in result:
        color_frame(result['color'])
        result['color'] = result['color'].upper()
    if 'power' in result and type(result['power']) is not bool:
        raise ValueError('Power must be on or off.')
    for key in ('front', 'rear'):
        if key in result:
            level(result[key])
    if 'mode' in result and result['mode'] not in ('solid', 'bass'):
        raise ValueError('Choose Solid or Bass pulse.')
    return result


class Replies:
    """Handles fragmented/coalesced notifications; ignores other vendor frames."""
    def __init__(self):
        self.buffer = b''

    def feed(self, data):
        self.buffer = (self.buffer+bytes(data))[-512:]
        result = []
        while b'>' in self.buffer:
            frame, self.buffer = self.buffer.split(b'>', 1)
            frame = frame.rsplit(b'<', 1)[-1]
            if not re.fullmatch(rb'[0-9A-Fa-f]{2,160}', frame) or len(frame) % 2:
                continue
            raw = bytes.fromhex(frame.decode('ascii'))
            if raw[0] == 0x13:
                try:
                    firmware = raw[1:].decode('ascii')
                    if firmware and all(32 <= ord(c) < 127 for c in firmware):
                        result.append(dict(firmware=firmware))
                except UnicodeError:
                    pass
            elif raw[0] == 0x1F and len(raw) == 15:
                if raw[3] not in (0, 1, 2) or raw[10] > 9 or raw[11] > 9:
                    continue
                result.append(dict(reported=dict(power=raw[3], effect=raw[2],
                    color='#'+raw[4:7].hex().upper(), rear_color='#'+raw[7:10].hex().upper(),
                    front=raw[10], rear=raw[11])))
        return result


def pulse_levels(front, rear, sample, sample_at, now):
    # Silence is a valid level; loss of the browser feed restores static levels.
    if sample_at is None or now-sample_at > 1.5:
        return (front, rear), False
    intensity = max(0., min(1., sample))
    return (round(front*intensity), round(rear*intensity)), True


class Lighting:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.started = False
        self.retry = threading.Event()
        self.queue = deque()
        self.link = False
        self.state = 'disabled'
        self.message = 'Lighting setup is not enabled.'
        self.reported = None
        self.reported_at = None
        self.firmware = ''
        self.mode = 'solid'
        self.limits = None
        self.bass = 0.
        self.bass_at = None
        self.pulsing = False
        self.pending = False
        self.error = ''

    def status(self):
        with self.lock:
            enabled = os.environ.get('CIVIC_LIGHTS_ENABLED') == '1'
            if enabled and not self.started:
                address = os.environ.get('CIVIC_LIGHTS_ADDRESS', '')
                if not ADDRESS.fullmatch(address):
                    self.state, self.message = 'setup', 'Configure the ATOTO light controller.'
                else:
                    self.started = True
                    self.state, self.message = 'connecting', 'Connecting to cabin lights…'
                    threading.Thread(target=lambda:asyncio.run(self._run(address)), daemon=True).start()
            age = None if self.reported_at is None else max(0, self.clock()-self.reported_at)
            connected = self.link and age is not None and age < 15
            state = 'stale' if self.link and not connected else self.state
            return dict(enabled=enabled, connected=connected, state=state,
                message='Waiting for the controller to report its state…' if state == 'stale' else self.message,
                reported=copy.deepcopy(self.reported) if connected else None,
                age_seconds=age, firmware=self.firmware, mode=self.mode,
                limits=copy.deepcopy(self.limits), pulsing=connected and self.pulsing,
                pending=self.pending, error=self.error)

    def submit(self, value):
        value = settings(value)
        if not self.status()['connected']:
            raise ConnectionError('Connect to the lights first.')
        with self.lock:
            if len(self.queue) >= 8:
                raise RuntimeError('Lighting controls are busy. Try again shortly.')
            self.queue.append(value)
            self.pending = True
            self.error = ''

    def pulse(self, value):
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError('Invalid bass level.')
        with self.lock:
            if self.mode != 'bass' or not self.link:
                return False
            self.bass, self.bass_at = float(value), self.clock()
            return True

    async def _run(self, address):
        try:
            from bleak import BleakClient, BleakScanner
            from bleak.backends.device import BLEDevice
        except ImportError:
            with self.lock:
                self.state, self.message = 'setup', 'Install the lighting requirements on the Pi.'
            return
        delay = 2
        while True:
            self.retry.clear()
            with self.lock:
                self.state, self.message = 'connecting', 'Connecting to cabin lights…'
            try:
                # Try BlueZ's cached device first; scan only if it has expired.
                device = BLEDevice(address, 'ATOTO lights', dict(path='/org/bluez/hci0/dev_'+address.replace(':','_'),
                    props={'Address':address,'AddressType':'public'}))
                try:
                    async with BleakClient(device, timeout=8) as client:
                        await self._session(client)
                except Exception as first:
                    if 'not found' not in str(first).lower():
                        raise
                    device = await BleakScanner.find_device_by_filter(lambda d,a:d.address.upper()==address.upper(),
                        timeout=4, bluez={'filters':{'Pattern':address}})
                    if device is None:
                        raise ConnectionError('Controller is not advertising.')
                    async with BleakClient(device, timeout=10) as client:
                        await self._session(client)
                delay = 2
            except Exception as error:
                with self.lock:
                    self.state, self.message = 'reconnecting', 'Light controller unavailable · retrying automatically.'
                    self.error = 'The lighting connection was interrupted.'
            finally:
                with self.lock:
                    self.state, self.message = 'reconnecting', 'Light controller disconnected · retrying automatically.'
                    self.link = self.pulsing = self.pending = False
                    self.bass_at = None
                    self.queue.clear()
            for _ in range(delay*5):
                if self.retry.is_set():
                    break
                await asyncio.sleep(.2)
            delay = min(30, delay*2)

    async def _session(self, client):
        char = client.services.get_characteristic(CHARACTERISTIC)
        if char is None or 'write-without-response' not in char.properties:
            raise RuntimeError('The connected device is not the expected light controller.')
        replies = Replies()
        def notify(characteristic, data):
            for item in replies.feed(data):
                with self.lock:
                    if 'firmware' in item:
                        self.firmware = item['firmware']
                    if 'reported' in item:
                        self.reported, self.reported_at = item['reported'], self.clock()
                        if self.limits is None:
                            self.limits = {k:self.reported[k] for k in ('front','rear')}
                        self.state, self.message = 'connected', 'ATOTO CI-FLT01 connected'
                        self.error = ''
        await client.start_notify(char, notify)
        with self.lock:
            self.link = True
            self.reported_at = None
            self.state, self.message = 'reading', 'Reading lighting state…'
        async def write(frame):
            if len(frame) > char.max_write_without_response_size:
                raise RuntimeError('Bluetooth packet size is too small for color control.')
            await client.write_gatt_char(char, frame, response=False)
            await asyncio.sleep(.05)
        await write(b'<0A01>')
        session_start = last_query = self.clock()
        last_levels = None
        was_pulsing = False
        while client.is_connected and not self.retry.is_set():
            with self.lock:
                item = self.queue.popleft() if self.queue else None
            if item is not None:
                with self.lock:
                    if 'mode' in item:
                        if self.mode == 'solid':
                            self.limits = {k:self.reported[k] for k in ('front','rear')}
                        self.mode = item['mode']
                        self.bass_at = None
                    for key in ('front','rear'):
                        if key in item:
                            self.limits[key] = item[key]
                    limits = dict(self.limits)
                if 'power' in item:
                    await write(b'<0701>' if item['power'] else b'<0700>')
                if 'color' in item or 'mode' in item:
                    await write(b'<1E18>')
                    await asyncio.sleep(.1)
                if 'color' in item:
                    await write(color_frame(item['color']))
                if set(item)&{'front','rear','mode'}:
                    for zone in ('front','rear'):
                        await write(brightness_frame(zone, limits[zone]))
                    last_levels = tuple(limits[k] for k in ('front','rear'))
                await write(b'<0A01>')
                last_query = self.clock()
                with self.lock:
                    self.pending = bool(self.queue)
            with self.lock:
                mode, limits = self.mode, copy.copy(self.limits)
                sample, sample_at = self.bass, self.bass_at
                report = copy.copy(self.reported)
                fresh = self.reported_at is not None and self.clock()-self.reported_at < 15
            if limits is not None and fresh and report['power'] == 1:
                target, pulsing = pulse_levels(limits['front'], limits['rear'], sample, sample_at, self.clock())
                pulsing = pulsing and mode == 'bass'
                if mode == 'bass' or was_pulsing:
                    if not pulsing:
                        target = (limits['front'], limits['rear'])
                    if target != last_levels:
                        for zone, value in zip(('front','rear'), target):
                            await write(brightness_frame(zone, value))
                        last_levels = target
                was_pulsing = pulsing
                with self.lock:
                    self.pulsing = pulsing
            else:
                with self.lock:
                    self.pulsing = False
            if self.clock()-last_query >= (2 if mode == 'bass' else 5):
                await write(b'<0A01>')
                last_query = self.clock()
            if self.clock()-(self.reported_at or session_start) > 18:
                raise ConnectionError('No lighting state reply.')
            await asyncio.sleep(.1)


def register_lighting(app):
    from flask import jsonify, request
    controller = Lighting()
    app.extensions['lighting'] = controller
    def local():
        return request.remote_addr in ('127.0.0.1','::1') and request.headers.get('X-Civic-Request') == '1'
    @app.get('/api/lights/status')
    def lights_status():
        return jsonify(controller.status())
    @app.post('/api/lights/settings')
    def lights_settings():
        if not local():
            return jsonify(error='Use the Pi lighting display.'),403
        try:
            controller.submit(request.get_json(silent=True))
        except ValueError as error:
            return jsonify(error=str(error)),400
        except ConnectionError as error:
            return jsonify(error=str(error)),409
        except RuntimeError as error:
            return jsonify(error=str(error)),429
        return jsonify(queued=True),202
    @app.post('/api/lights/pulse')
    def lights_pulse():
        if not local():
            return jsonify(error='Use the Pi lighting display.'),403
        value = request.get_json(silent=True)
        try:
            accepted = controller.pulse(value.get('level') if isinstance(value,dict) else None)
        except ValueError as error:
            return jsonify(error=str(error)),400
        return jsonify(accepted=accepted)
    @app.post('/api/lights/reconnect')
    def lights_reconnect():
        if not local():
            return jsonify(error='Use the Pi lighting display.'),403
        controller.status()
        controller.retry.set()
        return jsonify(queued=True),202
    return controller
