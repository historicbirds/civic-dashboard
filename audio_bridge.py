"""Local Bluetooth PCM bridge. Phone audio passes through the browser DSP once.

The virtual sink is deliberately silent without the dashboard. Never route the
processed Chromium output back into its input, or fall back to unprocessed audio
when a browser disconnects (which could cause a sudden volume increase).
"""
import json
import os
import select
import shutil
import subprocess
import threading
import time
import tempfile
from pathlib import Path

SINK = 'civic_bluetooth_input'
RATE = 48000
CHANNELS = 2
BLOCK_BYTES = 960 * CHANNELS * 4


class AudioUnavailable(RuntimeError):
    pass


def is_bluetooth_stream(item):
    props = item.get('properties', {})
    return (str(props.get('node.name', '')).startswith('bluez_input.')
            or bool(props.get('api.bluez5.address'))
            or str(props.get('device.api', '')) == 'bluez5')


class BluetoothBridge:
    def __init__(self):
        self._lock = threading.Lock()
        self._consumer = threading.Lock()
        self._started = False
        self._preference_loaded = False
        self._preferred_source = 'local'
        self._stop = threading.Event()
        self._status = dict(ready=False, connected=False, playing=False,
                            processing=False, error='', device='iPhone')

    @staticmethod
    def preference_path():
        return Path(os.environ.get('CIVIC_AUDIO_STATE_DIR',
                    str(Path(__file__).resolve().parent / 'data'))) / 'audio-source.json'

    def save_preference(self, source):
        if source not in ('bluetooth', 'local'):
            raise ValueError('Choose Bluetooth or local music.')
        path = self.preference_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode='w', dir=path.parent,
                                                  prefix='.audio-source-', delete=False) as output:
                    temporary = Path(output.name)
                    json.dump(dict(source=source), output)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, path)
                temporary = None
                self._preferred_source = source
                self._preference_loaded = True
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)

    @staticmethod
    def run(*args):
        try:
            result = subprocess.run(args, capture_output=True, text=True,
                                    timeout=3, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise AudioUnavailable('Pi audio service is unavailable.') from error
        if result.returncode:
            raise AudioUnavailable('Pi audio routing failed. Check PipeWire and HDMI.')
        return result.stdout.strip()

    def listing(self, kind):
        try:
            return json.loads(self.run('pactl', '-f', 'json', 'list', kind))
        except (ValueError, TypeError) as error:
            raise AudioUnavailable('Could not read Pi audio routing.') from error

    def hdmi_sink(self, sinks):
        configured = os.environ.get('CIVIC_HDMI_SINK')
        candidates = [s for s in sinks if s['name'] == configured] if configured else [
            s for s in sinks if 'hdmi' in s['name'].lower()
            and s['name'] != SINK]
        if not candidates:
            raise AudioUnavailable('No HDMI audio output is available.')
        default = self.run('pactl', 'get-default-sink')
        return next((s for s in candidates if s['name'] == default), candidates[0])

    def route_once(self):
        sinks = self.listing('sinks')
        hdmi = self.hdmi_sink(sinks)
        virtual = next((s for s in sinks if s['name'] == SINK), None)
        if virtual is None:
            self.run('pactl', 'load-module', 'module-null-sink', f'sink_name={SINK}',
                     'rate=48000', 'channels=2', 'channel_map=front-left,front-right',
                     'sink_properties=device.description=Civic-Bluetooth-input')
            sinks = self.listing('sinks')
            virtual = next((s for s in sinks if s['name'] == SINK), None)
            if virtual is None:
                raise AudioUnavailable('Bluetooth input could not be created.')
        # This also prevents a newly created virtual sink becoming the fallback.
        if self.run('pactl', 'get-default-sink') != hdmi['name']:
            self.run('pactl', 'set-default-sink', hdmi['name'])
        # The dashboard is the volume control; do not add a second HDMI attenuation.
        if os.environ.get('CIVIC_HDMI_UNITY') == '1' and any(
                channel.get('value') != 65536 for channel in hdmi.get('volume', {}).values()):
            self.run('pactl', 'set-sink-volume', hdmi['name'], '0dB')
        inputs = self.listing('sink-inputs')
        phones = [s for s in inputs if is_bluetooth_stream(s)]
        for stream in inputs:
            props = stream.get('properties', {})
            destination = virtual if is_bluetooth_stream(stream) else hdmi
            browser = any(name in str(props.get('application.name', '')).lower()
                          for name in ('chromium', 'chrome'))
            if (is_bluetooth_stream(stream) or browser) and stream['sink'] != destination['index']:
                self.run('pactl', 'move-sink-input', str(stream['index']), destination['name'])
        with self._lock:
            self._status.update(ready=True, connected=bool(phones),
                                playing=any(not s.get('corked', True) for s in phones),
                                error='')

    def _routing_loop(self):
        while not self._stop.is_set():
            try:
                self.route_once()
            except AudioUnavailable as error:
                with self._lock:
                    self._status.update(ready=False, connected=False, playing=False,
                                        error=str(error))
            self._stop.wait(.75)

    def status(self):
        enabled = os.environ.get('CIVIC_BLUETOOTH') == '1'
        with self._lock:
            if not self._preference_loaded:
                try:
                    source = json.loads(self.preference_path().read_text()).get('source')
                    if source in ('bluetooth', 'local'):
                        self._preferred_source = source
                except (OSError, ValueError, AttributeError):
                    pass
                self._preference_loaded = True
            if enabled and not self._started:
                if not all(shutil.which(tool) for tool in ('pactl', 'parec')):
                    self._status['error'] = 'Install pulseaudio-utils on the Pi.'
                else:
                    self._started = True
                    threading.Thread(target=self._routing_loop, daemon=True).start()
            return dict(self._status, enabled=enabled, sample_rate=RATE,
                        channels=CHANNELS, preferred_source=self._preferred_source)

    def stream(self, ws):
        status = self.status()
        if not status['enabled'] or not status['ready']:
            ws.send(json.dumps(dict(error=status['error'] or 'Bluetooth bridge is not enabled.')))
            return
        if not self._consumer.acquire(blocking=False):
            ws.send(json.dumps(dict(error='Bluetooth processing is open in another dashboard tab.')))
            return
        capture = None
        try:
            ws.send(json.dumps(dict(format='f32le', sample_rate=RATE, channels=CHANNELS)))
            if ws.receive(timeout=5) != 'ready':
                return
            capture = subprocess.Popen([
                'parec', f'--device={SINK}.monitor', '--format=float32le',
                '--rate=48000', '--channels=2', '--channel-map=front-left,front-right',
                '--latency-msec=40', '--property=application.name=Civic-Bluetooth-bridge',
            ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
            heartbeat = time.monotonic()
            pending = bytearray()
            while capture.poll() is None and time.monotonic() - heartbeat < 4:
                message = ws.receive(timeout=.001)
                if message == 'heartbeat':
                    heartbeat = time.monotonic()
                    with self._lock:
                        self._status['processing'] = True
                elif message is not None:
                    break
                readable, _, _ = select.select([capture.stdout], [], [], .1)
                if not readable:
                    continue
                block = os.read(capture.stdout.fileno(), BLOCK_BYTES)
                if not block:
                    break
                pending.extend(block)
                while len(pending) >= BLOCK_BYTES:
                    ws.send(bytes(pending[:BLOCK_BYTES]))
                    del pending[:BLOCK_BYTES]
        finally:
            if capture is not None:
                capture.terminate()
                try:
                    capture.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    capture.kill()
                    capture.wait()
                capture.stdout.close()
            with self._lock:
                self._status['processing'] = False
            self._consumer.release()


def register_audio_bridge(app):
    from flask import jsonify, request
    from flask_sock import Sock
    from simple_websocket import ConnectionClosed
    bridge = BluetoothBridge()
    app.extensions['bluetooth_bridge'] = bridge
    app.config['SOCK_SERVER_OPTIONS'] = dict(ping_interval=10, max_message_size=1024)
    sock = Sock(app)

    def local_request():
        return request.remote_addr in ('127.0.0.1', '::1')

    @app.get('/api/bluetooth/status')
    def bluetooth_status():
        if not local_request():
            return jsonify(error='Bluetooth audio is available on the Pi display only.'), 403
        return jsonify(bridge.status())

    @app.post('/api/bluetooth/source')
    def bluetooth_source():
        if not local_request() or request.headers.get('X-Civic-Request') != '1':
            return jsonify(error='Choose the source on the Pi display.'), 403
        payload = request.get_json(silent=True)
        source = payload.get('source') if isinstance(payload, dict) else None
        if not isinstance(source, str) or source not in ('bluetooth', 'local'):
            return jsonify(error='Choose Bluetooth or local music.'), 400
        try:
            bridge.save_preference(source)
        except OSError:
            return jsonify(error='Could not save the audio source.'), 503
        return jsonify(source=source)

    @sock.route('/api/bluetooth/audio')
    def bluetooth_audio(ws):
        # WebSocket cookies/CORS are insufficient: require the exact local origin.
        origin = request.headers.get('Origin', '')
        if not local_request() or origin != request.host_url.rstrip('/'):
            ws.close()
            return
        try:
            bridge.stream(ws)
        except ConnectionClosed:
            pass
        except (AudioUnavailable, OSError):
            try:
                ws.send(json.dumps(dict(error='Bluetooth audio stopped. Check Pi audio services.')))
            except Exception:
                pass
        finally:
            ws.close()

    return bridge
