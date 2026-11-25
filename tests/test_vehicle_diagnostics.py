import os
import time
import unittest
from unittest.mock import patch

import app as dashboard
from vehicle_diagnostics import VehicleDiagnostics, RFCOMMSerial, readonly_command


class VehicleDiagnosticsTests(unittest.TestCase):
    def test_wire_filter_allows_reads_and_adapter_initialization_only(self):
        for command in [b'ATZ',b'ATE0',b'ATH1',b'ATL0',b'AT RV',b'ATSP0',
                        b'ATDPN',b'ATTP7',b'ATSH7DF',b'0100',b'010C',b'0142',
                        b'03',b'07',b'0A',b'0900',b'0600']:
            self.assertIsNotNone(readonly_command(command),command)
        for command in [b'04',b'0400',b'08',b'1101',b'2701',b'2E1234',b'0902',
                        b'ATSH123',b'ATWMFF',b'ATPP00SVFF',b'',b'\x7f\x7f',
                        b'010C\r04',b'ATZ\r04']:
            self.assertIsNone(readonly_command(command),command)

    def test_real_library_over_private_serial_with_intermittent_capabilities(self):
        import socket
        import threading
        import serial
        from vehicle_diagnostics import open_obd
        left, right = socket.socketpair()
        commands = []
        errors = []
        class Link:
            def connect(self, address): pass
            def __getattr__(self, name): return getattr(left, name)
            def fileno(self): return left.fileno()
        def adapter():
            pending = b''
            try:
                while True:
                    data = right.recv(4096)
                    if not data: break
                    pending += data
                    while b'\r' in pending:
                        command, pending = pending.split(b'\r', 1)
                        commands.append(command)
                        if command == b'ATZ': response = b'ELM327 v1.5'
                        elif command == b'ATRV': response = b'14.2V'
                        elif command == b'ATE0': response = b'ATE0\rOK'
                        elif command == b'0100':
                            # First reply seeds the parser; discovery then misses
                            # once before receiving a real supported-PID bitmap.
                            response = b'NO DATA' if commands.count(command) == 2 else b'18 DA F1 10 06 41 00 BE 3F A8 13'
                        elif command == b'0120': response = b'18 DA F1 10 06 41 20 00 00 00 00'
                        elif command == b'010C': response = b'18 DA F1 10 04 41 0C 0A 7C'
                        elif command == b'010D': response = b'18 DA F1 10 03 41 0D 00'
                        elif command == b'03': response = b'18 DA F1 10 02 43 00'
                        else: response = b'OK'
                        right.sendall(response+b'\r>')
            except OSError as error:
                errors.append(error)
        # macOS tcdrain can block on PTYs; socket/PTY bytes still flow normally.
        worker = threading.Thread(target=adapter, daemon=True)
        worker.start()
        try:
            with patch.dict(os.environ, {'CIVIC_OBD_PROTOCOL':'7','CIVIC_OBD_HEADER':'18DB33F1'}), patch('vehicle_diagnostics.socket.socket', return_value=Link()), patch('vehicle_diagnostics.socket.AF_BLUETOOTH',31,create=True), patch('vehicle_diagnostics.socket.BTPROTO_RFCOMM',3,create=True), patch.object(serial.Serial,'flush',return_value=None):
                with RFCOMMSerial('AA:BB:CC:DD:EE:FF',2) as transport:
                    connection = open_obd(transport.port)
                    import obd
                    self.assertTrue(connection.pid_support[12])
                    self.assertEqual(connection.query(obd.commands.RPM).value.magnitude,671)
                    self.assertEqual(connection.query(obd.commands.SPEED).value.magnitude,0)
                    self.assertEqual(connection.query(obd.commands.GET_DTC,force=True).value,[])
                    # Forbidden commands are rejected at the actual relay boundary.
                    import serial
                    connection.close()
                    with serial.Serial(transport.port,timeout=1) as port:
                        port.write(b'04\r')
                        self.assertIn(b'?',port.read(3))
            self.assertNotIn(b'04',commands)
            self.assertGreaterEqual(commands.count(b'0100'),3)
            self.assertIn(b'ATSH18DB33F1',commands)
        finally:
            right.close()
            worker.join(timeout=2)

    def test_transport_validates_configuration_before_opening_socket(self):
        for address,channel in [('invalid',1),('AA:BB:CC:DD:EE:FF',0),('AA:BB:CC:DD:EE:FF',31)]:
            with self.assertRaises(ValueError):RFCOMMSerial(address,channel)

    def test_disabled_status_never_opens_hardware(self):
        reader=VehicleDiagnostics()
        with patch.dict(os.environ,{'CIVIC_OBD_ENABLED':'0'}),patch('vehicle_diagnostics.RFCOMMSerial') as transport:
            data=reader.status()
        transport.assert_not_called()
        self.assertFalse(data['live'])
        self.assertTrue(all(s['value'] is None for s in data['sensors'].values()))
        self.assertIsNone(data['codes'])

    def test_zero_values_are_valid_and_old_readings_expire(self):
        now=[100.0];reader=VehicleDiagnostics(clock=lambda:now[0])
        reader._state='live';reader._adapter_connected=True;reader._last_ecu=100
        reader._sensors={'rpm':dict(value=0,at=100,supported=True),
                         'speed':dict(value=0,at=100,supported=True)}
        self.assertEqual(reader.status()['sensors']['rpm']['value'],0)
        now[0]=104.1;reader._last_ecu=104
        data=reader.status()
        self.assertTrue(data['live'])
        self.assertIsNone(data['sensors']['rpm']['value'])
        self.assertEqual(data['sensors']['speed']['value'],0)
        now[0]=110
        data=reader.status()
        self.assertFalse(data['live']);self.assertEqual(data['state'],'stale')
        self.assertTrue(all(s['value'] is None for s in data['sensors'].values()))

    def test_disconnect_hides_old_codes_and_readings_immediately(self):
        reader=VehicleDiagnostics(clock=lambda:100)
        reader._state='reconnecting';reader._last_ecu=99
        reader._sensors={'rpm':dict(value=800,at=99,supported=True)}
        reader._dtcs=[dict(code='P0100',description='Example')]
        data=reader.status()
        self.assertFalse(data['live'])
        self.assertIsNone(data['sensors']['rpm']['value'])
        self.assertIsNone(data['codes'])

    def test_unsupported_is_distinct_from_stale(self):
        reader=VehicleDiagnostics(clock=lambda:100)
        reader._state='live';reader._last_ecu=100
        reader._sensors={'voltage':dict(value=None,at=None,supported=False)}
        self.assertFalse(reader.status()['sensors']['voltage']['supported'])

    def test_code_scan_has_no_false_no_codes_on_failed_read(self):
        from unittest.mock import Mock
        reader=VehicleDiagnostics(clock=lambda:100)
        connection=Mock();obd=Mock()
        connection.query.return_value.is_null.return_value=True
        reader._read_codes(connection,obd)
        self.assertIsNone(reader._dtcs)
        self.assertTrue(reader._codes_error)
        connection.query.return_value.is_null.return_value=False
        connection.query.return_value.value=[]
        reader._read_codes(connection,obd)
        self.assertEqual(reader._dtcs,[])
        self.assertFalse(reader._codes_error)

    def test_only_local_header_requests_can_trigger_reconnect_or_scan(self):
        client=dashboard.app.test_client()
        self.assertEqual(client.get('/api/obd/status').status_code,200)
        for endpoint in ['/api/obd/reconnect','/api/obd/codes']:
            self.assertEqual(client.post(endpoint).status_code,403)
            self.assertEqual(client.post(endpoint,headers={'X-Civic-Request':'1'},
                         environ_overrides={'REMOTE_ADDR':'192.168.1.2'}).status_code,403)
        self.assertEqual(client.post('/api/obd/codes',headers={'X-Civic-Request':'1'}).status_code,409)
        self.assertEqual(client.post('/api/obd/clear',headers={'X-Civic-Request':'1'}).status_code,404)


if __name__=='__main__':unittest.main()
