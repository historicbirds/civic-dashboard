"""Read-only ELM327 diagnostics over a paired Bluetooth serial adapter.

The private pseudo-terminal lets python-OBD use RFCOMM without root or a public
serial/TCP listener. The relay independently rejects vehicle-control commands.
"""
import copy
import math
import os
import re
import select
import socket
import threading
import time
import tty


def readonly_command(raw):
    command = b''.join(raw.upper().split())
    adapter = {b'ATZ', b'ATE0', b'ATH1', b'ATL0', b'ATRV', b'ATI', b'ATDP',
               b'ATDPN', b'ATSP0', b'ATSH7DF', b'ATSH7E0', b'ATSH7E1', b'ATSH18DB33F1'}
    if command in adapter or re.fullmatch(rb'ATTP[1-9A]', command) or re.fullmatch(rb'ATSP[0-9A]', command):
        return command
    if re.fullmatch(rb'01[0-9A-F]{2}', command):
        return command
    if command in {b'03', b'07', b'0A', b'0900'}:
        return command
    if re.fullmatch(rb'06(?:00|20|40|60|80|A0|C0)', command):
        return command
    return None


class RFCOMMSerial:
    def __init__(self, address, channel=1):
        if not re.fullmatch(r'(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}', address):
            raise ValueError('Configure the paired OBD2 adapter address.')
        if not 1 <= channel <= 30:
            raise ValueError('Invalid Bluetooth serial channel.')
        self.address, self.channel = address, channel
        self.closed = threading.Event()
        self.sock = None
        self.master = self.slave = None
        self.error = None

    def __enter__(self):
        try:
            self.sock = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM,
                                      socket.BTPROTO_RFCOMM)
            self.sock.settimeout(6)
            self.sock.connect((self.address, self.channel))
            self.master, self.slave = os.openpty()
            tty.setraw(self.slave)
            self.port = os.ttyname(self.slave)
            os.chmod(self.port, 0o600)
            self.sock.settimeout(2)
            self.thread = threading.Thread(target=self._relay, daemon=True)
            self.thread.start()
            return self
        except BaseException:
            self.close()
            raise

    def _relay(self):
        pending = bytearray()
        try:
            while not self.closed.is_set():
                readable, _, _ = select.select([self.master, self.sock], [], [], .2)
                if self.sock in readable:
                    data = self.sock.recv(4096)
                    if not data:
                        raise ConnectionError('OBD2 Bluetooth connection ended.')
                    os.write(self.master, data)
                if self.master in readable:
                    data = os.read(self.master, 4096)
                    if not data:
                        break
                    pending.extend(data)
                    if len(pending) > 256:
                        raise ValueError('Invalid ELM327 command length.')
                    while b'\r' in pending:
                        raw, _, rest = pending.partition(b'\r')
                        pending = bytearray(rest)
                        command = readonly_command(raw)
                        if command is None:
                            os.write(self.master, b'?\r>')
                        else:
                            self.sock.sendall(command + b'\r')
        except (OSError, ValueError, ConnectionError) as error:
            self.error = error
        finally:
            self.closed.set()
            if self.master is not None:
                try:
                    os.close(self.master)
                except OSError:
                    pass
                self.master = None

    def close(self):
        self.closed.set()
        if self.sock is not None:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.sock.close()
        if hasattr(self, 'thread'):
            self.thread.join(timeout=3)
        for name in ('master', 'slave'):
            value = getattr(self, name)
            if value is not None:
                try:
                    os.close(value)
                except OSError:
                    pass
                setattr(self, name, None)

    def __exit__(self, *args):
        self.close()


# key, python-OBD command, displayed unit, query interval, freshness limit
SENSORS = (
    ('rpm', 'RPM', 'rpm', .4, 4),
    ('coolant', 'COOLANT_TEMP', 'degF', 1.5, 8),
    ('voltage', 'CONTROL_MODULE_VOLTAGE', 'volt', 2, 10),
    ('speed', 'SPEED', 'mph', .7, 5),
    ('load', 'ENGINE_LOAD', 'percent', 1, 6),
    ('throttle', 'THROTTLE_POS', 'percent', 1, 6),
    ('intake', 'INTAKE_TEMP', 'degF', 3, 12),
    ('map', 'INTAKE_PRESSURE', 'kPa', 2, 10),
    ('short_trim', 'SHORT_FUEL_TRIM_1', 'percent', 3, 12),
    ('long_trim', 'LONG_FUEL_TRIM_1', 'percent', 5, 15),
)


def open_obd(port):
    import obd
    header = os.environ.get('CIVIC_OBD_HEADER', '').upper()
    protocol = os.environ.get('CIVIC_OBD_PROTOCOL') or None
    if header not in ('', '7DF', '18DB33F1'):
        raise ValueError('Only standard OBD2 functional request headers are supported.')
    if protocol is not None and protocol not in tuple('123456789A'):
        raise ValueError('Invalid ELM327 protocol.')

    class FunctionalOBD(obd.OBD):
        # Isolated compatibility hook for the pinned python-OBD 0.7.3 release.
        # Some clones report CAR_CONNECTED on NO DATA. Discover only mode 01,
        # retry missing capability replies, and never equate silence with absence.
        def _OBD__load_commands(self):
            self.pid_support = {}
            if not self.is_connected():
                return
            if header:
                if protocol:
                    self.interface.send_and_parse(b'ATSP'+protocol.encode('ascii'))
                self.interface.send_and_parse(b'ATSH'+header.encode('ascii'))
            for base in (0, 32, 64):
                if base and self.pid_support.get(base) is not True:
                    break
                command = obd.commands[1][base]
                for attempt in range(4):
                    messages = self.interface.send_and_parse(command.command)
                    parser = self.interface._ELM327__protocol
                    parser.populate_ecu_map(messages)
                    for message in messages:
                        message.ecu = parser.ecu_map.get(message.tx_id, obd.protocols.ECU.UNKNOWN)
                    response = command(messages)
                    if not response.is_null():
                        for offset, bit in enumerate(response.value, 1):
                            pid = base+offset
                            self.pid_support[pid] = bool(bit)
                            if bit and obd.commands.has_pid(1, pid):
                                self.supported_commands.add(obd.commands[1][pid])
                        break
                    time.sleep(.25)

    return FunctionalOBD(port, baudrate=38400, protocol=protocol, fast=False, timeout=1, check_voltage=True)


class VehicleDiagnostics:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self._lock = threading.Lock()
        self._started = False
        self._retry = threading.Event()
        self._scan_codes = threading.Event()
        self._state = 'disabled'
        self._message = 'OBD2 setup is not enabled.'
        self._adapter_connected = False
        self._last_ecu = None
        self._protocol = ''
        self._sensors = {}
        self._dtcs = None
        self._dtcs_at = None
        self._codes_error = ''
        self._voltage_source = 'ecu'

    def _set_state(self, state, message, adapter=False):
        with self._lock:
            self._state, self._message = state, message
            self._adapter_connected = adapter

    def status(self):
        enabled = os.environ.get('CIVIC_OBD_ENABLED') == '1'
        address = os.environ.get('CIVIC_OBD_ADDRESS', '')
        with self._lock:
            if enabled and not self._started:
                if not re.fullmatch(r'(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}', address):
                    self._state, self._message = 'setup', 'Configure a paired ELM327 adapter.'
                else:
                    self._started = True
                    self._state, self._message = 'connecting', 'Connecting to ELM327…'
                    threading.Thread(target=self._run, args=(address,), daemon=True).start()
            now = self.clock()
            age = None if self._last_ecu is None else max(0, now-self._last_ecu)
            live = self._state == 'live' and age is not None and age < 5
            state = 'stale' if self._state == 'live' and not live else self._state
            sensors = {}
            for key, command, unit, interval, ttl in SENSORS:
                sample = self._sensors.get(key)
                sample_age = None if not sample or sample.get('at') is None else max(0, now-sample['at'])
                fresh = live and sample_age is not None and sample_age < ttl
                sensors[key] = dict(value=sample['value'] if sample and fresh else None,
                                    supported=None if sample is None else sample['supported'],
                                    age_seconds=sample_age, unit=unit)
            return dict(enabled=enabled, state=state, live=live,
                        adapter_connected=self._adapter_connected,
                        message='Vehicle readings are stale; reconnecting…' if state == 'stale' else self._message,
                        protocol=self._protocol if self._adapter_connected else '', age_seconds=age, sensors=sensors,
                        voltage_source=self._voltage_source,
                        codes=copy.deepcopy(self._dtcs) if live else None,
                        codes_age_seconds=None if self._dtcs_at is None else max(0, now-self._dtcs_at),
                        codes_error=self._codes_error,
                        codes_scanning=self._scan_codes.is_set())

    def retry(self):
        self._retry.set()

    def scan_codes(self):
        if not self.status()['live']:
            return False
        self._scan_codes.set()
        return True

    def _run(self, address):
        delay = 2
        while True:
            self._retry.clear()
            self._set_state('connecting', 'Connecting to ELM327…')
            try:
                with RFCOMMSerial(address, int(os.environ.get('CIVIC_OBD_CHANNEL', '1'))) as serial:
                    self._set_state('initializing', 'ELM327 connected · identifying vehicle protocol…', True)
                    self._read_vehicle(serial)
            except ImportError:
                self._set_state('setup', 'Install the OBD2 reader requirements on the Pi.')
                return
            except (OSError, ValueError, RuntimeError):
                self._set_state('reconnecting', 'ELM327 unavailable · retrying automatically.')
            with self._lock:
                self._adapter_connected = False
            self._retry.wait(delay)
            delay = min(20, delay*2)

    def _read_vehicle(self, serial):
        import obd
        connection = None
        try:
            connection = open_obd(serial.port)
            if not connection.is_connected():
                self._set_state('adapter_only', 'ELM327 answered, but the ECU did not respond. Check ignition and OBD2 plug.', True)
                return
            with self._lock:
                self._protocol = connection.protocol_name()
                self._sensors = {}
                self._dtcs = self._dtcs_at = None
                self._codes_error = ''
                self._voltage_source = 'ecu'
            queries = []
            for key, command_name, unit, interval, ttl in SENSORS:
                command = getattr(obd.commands, command_name)
                if key == 'voltage' and connection.pid_support.get(command.pid) is not True:
                    command = obd.commands.ELM_VOLTAGE
                    with self._lock:
                        self._voltage_source = 'adapter'
                supported = connection.pid_support.get(command.pid) if command.mode == 1 else True
                with self._lock:
                    self._sensors[key] = dict(value=None, at=None, supported=supported)
                if supported is not False:
                    queries.append([key, command, unit, interval, 0])
            last_success = self.clock()
            self._scan_codes.set()
            while not serial.closed.is_set() and not self._retry.is_set():
                for query in queries:
                    key, command, unit, interval, due = query
                    if self.clock() < due:
                        continue
                    response = connection.query(command, force=True)
                    # Give the primary gauges bounded retries on NO DATA. Do not
                    # reset the adapter or classify a missed reply as unsupported.
                    for attempt in range(2 if key in ('rpm', 'coolant', 'speed') else 0):
                        if not response.is_null() or serial.closed.is_set() or self._retry.is_set():
                            break
                        time.sleep(.1)
                        response = connection.query(command, force=True)
                    query[4] = self.clock()+interval
                    value = None
                    if not response.is_null():
                        try:
                            value = float(response.value.to(unit).magnitude)
                            if not math.isfinite(value):
                                value = None
                        except (AttributeError, ValueError, TypeError):
                            pass
                    with self._lock:
                        if value is not None:
                            self._sensors[key].update(value=value, at=self.clock(), supported=True)
                        if value is not None and command != obd.commands.ELM_VOLTAGE:
                            self._last_ecu = self.clock()
                            self._state, self._message = 'live', 'Live vehicle data'
                            last_success = self.clock()
                    if serial.closed.is_set() or self._retry.is_set():
                        break
                    time.sleep(.15)
                if self._scan_codes.is_set():
                    self._read_codes(connection, obd)
                    self._scan_codes.clear()
                if self.clock()-last_success > 30:
                    self._set_state('stale', 'ECU stopped responding · reconnecting…', True)
                    return
                self._retry.wait(.05)
        finally:
            if connection is not None:
                connection.close()

    def _read_codes(self, connection, obd):
        response = connection.query(obd.commands.GET_DTC, force=True)
        with self._lock:
            if response.is_null():
                self._dtcs = None
                self._codes_error = 'Trouble codes could not be read. Try Scan codes again.'
            else:
                self._dtcs = [dict(code=str(code), description=str(description))
                              for code, description in response.value]
                self._dtcs_at = self.clock()
                self._codes_error = ''


def register_vehicle_diagnostics(app):
    from flask import jsonify, request
    reader = VehicleDiagnostics()
    app.extensions['vehicle_diagnostics'] = reader

    @app.get('/api/obd/status')
    def obd_status():
        return jsonify(reader.status())

    def local_action():
        return request.remote_addr in ('127.0.0.1', '::1') and request.headers.get('X-Civic-Request') == '1'

    @app.post('/api/obd/reconnect')
    def obd_reconnect():
        if not local_action():
            return jsonify(error='Use the Pi diagnostics display.'), 403
        reader.status()
        reader.retry()
        return jsonify(queued=True), 202

    @app.post('/api/obd/codes')
    def obd_codes():
        if not local_action():
            return jsonify(error='Use the Pi diagnostics display.'), 403
        if not reader.scan_codes():
            return jsonify(error='Connect to the vehicle before reading codes.'), 409
        return jsonify(queued=True), 202

    return reader
