import asyncio
import os
import unittest
from unittest.mock import patch

import app as dashboard
from lighting import Lighting, Replies, brightness_frame, color_frame, pulse_levels, settings

STATE=b'<1F001801398BFF398BFF0303090400>'


class LightingTests(unittest.TestCase):
    def test_only_known_controls_can_build_frames(self):
        self.assertEqual(color_frame('#398bff'),b'AT+<06398BFF>0000FF1100001000800000805F9B34FB')
        self.assertEqual(brightness_frame('front',3),b'<010103>')
        self.assertEqual(brightness_frame('rear',0),b'<010200>')
        for value in [None,{}, {'raw':'<FFFF>'},{'power':1},{'front':True},{'rear':10},{'front':-1},{'mode':'strobe'},{'color':'red'},{'color':'#123456><0700>'}]:
            with self.assertRaises(ValueError):settings(value)

    def test_fragmented_and_combined_real_notifications(self):
        reader=Replies()
        self.assertEqual(reader.feed(STATE[:10]),[])
        decoded=reader.feed(STATE[10:]+b'<1356322E3030><2601FFFFFFFFFF00000304FF00>')
        self.assertEqual(decoded[0]['reported'],dict(power=1,effect=24,color='#398BFF',rear_color='#398BFF',front=3,rear=3))
        self.assertEqual(decoded[1],dict(firmware='V2.00'))
        self.assertEqual(len(decoded),2)
        self.assertEqual(reader.feed(b'<1F001801398BFF398BFFFA03090400>'),[])
        self.assertEqual(reader.feed(b'junk'*300+b'<NOPE>'),[])

    def test_status_needs_a_fresh_controller_reply(self):
        now=[100];controller=Lighting(clock=lambda:now[0])
        with patch.dict(os.environ,{'CIVIC_LIGHTS_ENABLED':'0'}):
            self.assertFalse(controller.status()['connected'])
            controller.link=True
            self.assertIsNone(controller.status()['reported'])
            controller.reported={'power':1};controller.reported_at=100
            self.assertTrue(controller.status()['connected'])
            now[0]=116
            self.assertFalse(controller.status()['connected'])
            self.assertIsNone(controller.status()['reported'])
            controller.link=False;now[0]=101
            self.assertFalse(controller.status()['connected'])

    def test_disconnected_commands_and_queue_limit(self):
        controller=Lighting(clock=lambda:100)
        with self.assertRaises(ConnectionError):controller.submit({'power':True})
        controller.link=True;controller.reported_at=100
        for i in range(8):controller.submit({'front':i})
        with self.assertRaises(RuntimeError):controller.submit({'front':1})
        self.assertTrue(controller.pending)

    def test_pulse_is_bounded_and_watchdog_restores_brightness(self):
        self.assertEqual(pulse_levels(3,9,0,100,100),((0,0),True))
        self.assertEqual(pulse_levels(3,9,1,100,100),((3,9),True))
        self.assertEqual(pulse_levels(3,9,99,100,100),((3,9),True))
        self.assertEqual(pulse_levels(3,9,1,100,102),((3,9),False))
        self.assertEqual(pulse_levels(3,9,1,None,100),((3,9),False))
        controller=Lighting()
        for value in [True,None,float('nan'),float('inf'),-1,2]:
            with self.assertRaises(ValueError):controller.pulse(value)
        self.assertFalse(controller.pulse(.5))

    def test_session_reads_state_and_writes_only_typed_controls(self):
        controller=Lighting()
        class Char:
            properties=['notify','write-without-response']
            max_write_without_response_size=509
        class Services:
            def get_characteristic(self,uuid):return Char()
        class Client:
            services=Services();is_connected=True
            def __init__(self):self.frames=[]
            async def start_notify(self,char,callback):self.callback=callback
            async def write_gatt_char(self,char,frame,response):
                self.frames.append(frame)
                if frame==b'<0A01>':
                    self.callback(char,STATE)
                    if self.frames.count(b'<0A01>')==1:
                        controller.submit({'color':'#FF0000','front':4,'mode':'bass'})
                    else:controller.retry.set()
        client=Client();asyncio.run(controller._session(client))
        self.assertIn(color_frame('#FF0000'),client.frames)
        self.assertIn(brightness_frame('front',4),client.frames)
        self.assertEqual(controller.reported['color'],'#398BFF') # no optimistic success
        self.assertEqual(controller.limits,dict(front=4,rear=3))

    def test_local_routes_reject_foreign_requests_and_raw_commands(self):
        client=dashboard.app.test_client()
        self.assertEqual(client.get('/api/lights/status').status_code,200)
        for endpoint in ['/api/lights/settings','/api/lights/pulse','/api/lights/reconnect']:
            self.assertEqual(client.post(endpoint,json={}).status_code,403)
            self.assertEqual(client.post(endpoint,json={},headers={'X-Civic-Request':'1'},environ_overrides={'REMOTE_ADDR':'192.168.1.8'}).status_code,403)
        self.assertEqual(client.post('/api/lights/settings',json={'raw':'<0701>'},headers={'X-Civic-Request':'1'}).status_code,400)
        self.assertEqual(client.post('/api/lights/pulse',json={'level':'1'},headers={'X-Civic-Request':'1'}).status_code,400)


if __name__=='__main__':unittest.main()
