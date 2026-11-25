import json
import os
import unittest
import tempfile
from unittest.mock import Mock, patch

import app as dashboard
from audio_bridge import BluetoothBridge, AudioUnavailable, SINK, is_bluetooth_stream


class BridgeTests(unittest.TestCase):
    def test_only_bluetooth_streams_are_identified(self):
        self.assertTrue(is_bluetooth_stream({'properties': {'node.name': 'bluez_input.AB.0'}}))
        self.assertTrue(is_bluetooth_stream({'properties': {'api.bluez5.address': 'AA:BB'}}))
        for name in ('Chromium', 'Civic-Bluetooth-bridge', 'bluez_output.AB.0'):
            self.assertFalse(is_bluetooth_stream({'properties': {'node.name': name}}))

    def test_routes_phone_to_input_and_browser_to_hdmi_without_loopback(self):
        bridge = BluetoothBridge()
        hdmi = dict(index=35, name='alsa_output.hdmi.stereo')
        virtual = dict(index=70, name=SINK)
        phone = dict(index=90, sink=35, corked=False,
                     properties={'node.name': 'bluez_input.AB.0'})
        browser = dict(index=91, sink=70, properties={'application.name': 'Chromium'})
        unrelated = dict(index=92, sink=9, properties={'application.name': 'Other app'})
        bridge.listing = Mock(side_effect=[[hdmi, virtual], [phone, browser, unrelated]])
        bridge.run = Mock(return_value=hdmi['name'])
        bridge.route_once()
        bridge.run.assert_any_call('pactl', 'move-sink-input', '90', SINK)
        bridge.run.assert_any_call('pactl', 'move-sink-input', '91', hdmi['name'])
        self.assertEqual(sum('move-sink-input' in call.args for call in bridge.run.call_args_list), 2)
        self.assertTrue(bridge._status['playing'])

    def test_no_hdmi_does_not_change_routing(self):
        bridge = BluetoothBridge()
        bridge.listing = Mock(return_value=[dict(index=1, name='analog')])
        bridge.run = Mock()
        with self.assertRaises(AudioUnavailable):
            bridge.route_once()
        bridge.run.assert_not_called()

    def test_hdmi_unity_calibration_does_not_boost_input_or_repeat_at_unity(self):
        hdmi=dict(index=35,name='alsa_output.hdmi.stereo',volume={
            'front-left':{'value':42598},'front-right':{'value':42598}})
        virtual=dict(index=70,name=SINK)
        bridge=BluetoothBridge()
        bridge.listing=Mock(side_effect=[[hdmi,virtual],[],[hdmi,virtual],[]])
        bridge.run=Mock(return_value=hdmi['name'])
        with patch.dict(os.environ,{'CIVIC_HDMI_UNITY':'1'}):
            bridge.route_once()
            bridge.run.assert_any_call('pactl','set-sink-volume',hdmi['name'],'0dB')
            hdmi['volume']={name:{'value':65536} for name in hdmi['volume']}
            bridge.run.reset_mock()
            bridge.route_once()
            self.assertFalse(any('set-sink-volume' in call.args for call in bridge.run.call_args_list))

    def test_hdmi_configuration_must_match_an_existing_sink(self):
        bridge = BluetoothBridge()
        with patch.dict(os.environ, {'CIVIC_HDMI_SINK': 'missing'}):
            with self.assertRaises(AudioUnavailable):
                bridge.hdmi_sink([dict(index=35, name='hdmi')])

    def test_disabled_bridge_does_not_launch_commands(self):
        bridge = BluetoothBridge()
        bridge.run = Mock()
        with patch.dict(os.environ, {'CIVIC_BLUETOOTH': '0'}):
            self.assertFalse(bridge.status()['enabled'])
        bridge.run.assert_not_called()

    def test_source_preference_survives_new_bridge_instance(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                'CIVIC_AUDIO_STATE_DIR': directory, 'CIVIC_BLUETOOTH': '0'}):
            BluetoothBridge().save_preference('bluetooth')
            self.assertEqual(BluetoothBridge().status()['preferred_source'], 'bluetooth')
            BluetoothBridge().save_preference('local')
            self.assertEqual(BluetoothBridge().status()['preferred_source'], 'local')
            with self.assertRaises(ValueError):
                BluetoothBridge().save_preference('invalid')

    def test_source_endpoint_requires_local_custom_header_and_valid_choice(self):
        client = dashboard.app.test_client()
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                'CIVIC_AUDIO_STATE_DIR': directory}):
            self.assertEqual(client.post('/api/bluetooth/source', json={'source':'bluetooth'}).status_code, 403)
            headers={'X-Civic-Request':'1'}
            self.assertEqual(client.post('/api/bluetooth/source', headers=headers,
                            json={'source':{}}).status_code,400)
            self.assertEqual(client.post('/api/bluetooth/source', headers=headers,
                            json={'source':'bluetooth'}, environ_overrides={'REMOTE_ADDR':'192.168.1.2'}).status_code,403)
            self.assertEqual(client.post('/api/bluetooth/source', headers=headers,
                            json={'source':'bluetooth'}).status_code,200)

    def test_remote_browser_cannot_access_audio_status(self):
        response = dashboard.app.test_client().get('/api/bluetooth/status',
                          environ_overrides={'REMOTE_ADDR': '192.168.1.2'})
        self.assertEqual(response.status_code, 403)

    def test_second_consumer_is_rejected_and_does_not_release_first_lease(self):
        bridge = BluetoothBridge()
        bridge.status = Mock(return_value=dict(enabled=True, ready=True))
        ws = Mock()
        bridge._consumer.acquire()
        try:
            bridge.stream(ws)
            self.assertIn('another dashboard', json.loads(ws.send.call_args.args[0])['error'])
            self.assertFalse(bridge._consumer.acquire(blocking=False))
        finally:
            bridge._consumer.release()

    def test_client_must_acknowledge_format_before_capture(self):
        bridge = BluetoothBridge()
        bridge.status = Mock(return_value=dict(enabled=True, ready=True))
        ws = Mock()
        ws.receive.return_value = None
        with patch('audio_bridge.subprocess.Popen') as popen:
            bridge.stream(ws)
            popen.assert_not_called()
        self.assertTrue(bridge._consumer.acquire(blocking=False))
        bridge._consumer.release()


if __name__ == '__main__':
    unittest.main()
