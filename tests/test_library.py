import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app as dashboard


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.environment = patch.dict(os.environ, {
            'CIVIC_MUSIC_DIRS': str(self.root),
            'CIVIC_LIBRARY_DIR': str(self.root / 'onboard'),
        })
        self.environment.start()
        self.client = dashboard.app.test_client()

    def tearDown(self):
        self.environment.stop()
        self.directory.cleanup()

    def test_index_and_audio_scan(self):
        (self.root / 'album').mkdir()
        (self.root / 'album' / 'Track.FLAC').write_bytes(b'fLaC0123456789')
        (self.root / 'notes.txt').write_text('not audio')
        (self.root / '.hidden.mp3').write_bytes(b'hidden')
        (self.root / '.private').mkdir()
        (self.root / '.private' / 'hidden.flac').write_bytes(b'hidden')
        self.assertEqual(self.client.get('/').status_code, 200)
        tracks = self.client.get('/api/library').json['tracks']
        self.assertEqual(len(tracks), 1)
        self.assertEqual(tracks[0]['title'], 'Track')
        self.assertEqual(tracks[0]['format'], 'FLAC')
        self.assertNotIn(str(self.root), str(tracks))
        response = self.client.get(tracks[0]['url'], headers={'Range': 'bytes=4-7'})
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.data, b'0123')
        self.assertEqual(response.headers['Content-Range'], 'bytes 4-7/14')
        response.close()

    def test_reject_symlinks_and_unindexed_paths(self):
        with tempfile.TemporaryDirectory() as outside:
            secret = Path(outside) / 'outside.flac'
            secret.write_bytes(b'secret')
            (self.root / 'escape.flac').symlink_to(secret)
            (self.root / 'escape-directory').symlink_to(Path(outside), target_is_directory=True)
            self.assertEqual(self.client.get('/api/library').json['tracks'], [])
            self.assertEqual(self.client.get('/api/media/not-a-known-track').status_code, 404)

    def test_unplugged_or_replaced_file(self):
        track = self.root / 'song.flac'
        track.write_bytes(b'fLaC0123456789')
        url = self.client.get('/api/library').json['tracks'][0]['url']
        track.unlink()
        self.assertEqual(self.client.get(url).status_code, 404)
        with tempfile.TemporaryDirectory() as outside:
            secret = Path(outside) / 'song.flac'
            secret.write_bytes(b'outside')
            track.symlink_to(secret)
            self.assertEqual(self.client.get(url).status_code, 404)

    def test_limit_and_missing_mount(self):
        for i in range(3):
            (self.root / f'{i}.flac').write_bytes(b'fLaC')
        with patch.object(dashboard, 'MAX_LIBRARY_TRACKS', 2):
            response = self.client.get('/api/library').json
            self.assertEqual(len(response['tracks']), 2)
            self.assertTrue(response['truncated'])
        with patch.dict(os.environ, {'CIVIC_MUSIC_DIRS': str(self.root / 'not-mounted')}):
            self.assertEqual(self.client.get('/api/library').json['tracks'], [])

    def test_scan_lock(self):
        dashboard._scan_lock.acquire()
        try:
            self.assertEqual(self.client.get('/api/library').status_code, 409)
        finally:
            dashboard._scan_lock.release()

    def test_usb_copy_survives_source_removal_and_reindex(self):
        source = self.root / 'My song.flac'
        content = b'fLaC-lossless-original-bytes'
        source.write_bytes(content)
        original = self.client.get('/api/library').json['tracks'][0]
        response = self.client.post('/api/library/import', json={'track_id': original['id']},
                                    headers={'X-Civic-Request': '1'})
        self.assertEqual(response.status_code, 201)
        saved = response.json['track']
        self.assertEqual(saved['origin'], 'onboard')
        self.assertEqual(source.read_bytes(), content)
        source.unlink()
        with dashboard._library_lock:
            dashboard._library.clear()
        tracks = self.client.get('/api/library').json['tracks']
        self.assertEqual(len(tracks), 1)
        self.assertEqual(tracks[0]['id'], saved['id'])
        playback = self.client.get(saved['url'])
        self.assertEqual(playback.data, content)
        playback.close()

    def test_upload_deduplicates_by_content_and_sanitizes_filename(self):
        def upload(filename):
            return self.client.post('/api/library/import',
                data={'file': (io.BytesIO(b'fLaC-same-content'), filename)},
                headers={'X-Civic-Request': '1'})
        first = upload('../../Original song.flac')
        self.assertEqual(first.status_code, 201)
        second = upload('Another name.flac')
        self.assertEqual(second.status_code, 200)
        self.assertTrue(second.json['already_saved'])
        self.assertEqual(first.json['track']['id'], second.json['track']['id'])
        files = list(dashboard.onboard_root().rglob('*.flac'))
        self.assertEqual(len(files), 1)
        self.assertTrue(files[0].is_relative_to(dashboard.onboard_root()))
        self.assertFalse(list(dashboard.onboard_root().glob('.import-*')))

    def test_import_requires_header_and_rejects_invalid_uploads(self):
        self.assertEqual(self.client.post('/api/library/import', json={}).status_code, 403)
        for data, status in [({'file': (io.BytesIO(b'code'), 'file.py')}, 400),
                             ({'file': (io.BytesIO(b''), 'empty.flac')}, 400)]:
            self.assertEqual(self.client.post('/api/library/import', data=data,
                headers={'X-Civic-Request': '1'}).status_code, status)
        self.assertFalse(list(dashboard.onboard_root().glob('.import-*')))

    def test_import_missing_source_and_low_disk(self):
        response = self.client.post('/api/library/import', json={'track_id': 'missing'},
                                    headers={'X-Civic-Request': '1'})
        self.assertEqual(response.status_code, 404)
        with patch.object(dashboard.shutil, 'disk_usage') as usage:
            usage.return_value.free = 0
            response = self.client.post('/api/library/import',
                data={'file': (io.BytesIO(b'fLaC-data'), 'song.flac')},
                headers={'X-Civic-Request': '1'})
            self.assertEqual(response.status_code, 507)
        self.assertFalse(list(dashboard.onboard_root().rglob('*.flac')))

    def test_interrupted_copy_leaves_no_partial_track(self):
        class BrokenSource:
            def read(self, size):
                raise OSError('drive removed')
        with self.assertRaises(OSError):
            dashboard.save_onboard(BrokenSource(), 'song.flac')
        self.assertFalse(list(dashboard.onboard_root().rglob('*.flac')))
        self.assertFalse(list(dashboard.onboard_root().glob('.import-*')))

    def saved_fixture(self, filename='saved.flac'):
        response = self.client.post('/api/library/import',
            data={'file': (io.BytesIO(b'fLaC-fixture-original'), filename)},
            headers={'X-Civic-Request':'1'})
        self.assertEqual(response.status_code,201)
        track = response.json['track']
        return track, dashboard._library[track['id']]

    def delete_saved(self, track, **kwargs):
        return self.client.delete('/api/library/'+track['id'],
            json={'confirm':True,'delete_token':track['delete_token']},
            headers={'X-Civic-Request':'1'}, **kwargs)

    def test_delete_saved_copy_preserves_original_usb_and_other_music(self):
        original = self.root/'original.flac';original.write_bytes(b'fLaC-fixture-original')
        other = self.root/'other.flac';other.write_bytes(b'fLaC-other')
        self.client.get('/api/library')
        saved, path = self.saved_fixture()
        response = self.delete_saved(saved)
        self.assertEqual(response.status_code,200)
        self.assertTrue(response.json['deleted'])
        self.assertFalse(path.exists())
        self.assertEqual(original.read_bytes(),b'fLaC-fixture-original')
        self.assertEqual(other.read_bytes(),b'fLaC-other')
        self.assertEqual(self.client.get(saved['url']).status_code,404)
        tracks = self.client.get('/api/library').json['tracks']
        self.assertEqual(len(tracks),2)
        self.assertTrue(all(t['origin']=='usb' for t in tracks))
        # The content can be saved again after its local copy was deleted.
        again, path = self.saved_fixture()
        self.assertTrue(path.is_file())

    def test_delete_requires_local_confirmation_and_indexed_onboard_file(self):
        saved,path = self.saved_fixture()
        url='/api/library/'+saved['id']
        self.assertEqual(self.client.delete(url).status_code,403)
        self.assertEqual(self.client.delete(url,json={'confirm':True,'delete_token':saved['delete_token']},headers={'X-Civic-Request':'1'},environ_overrides={'REMOTE_ADDR':'192.168.1.9'}).status_code,403)
        for payload in [None,{}, {'confirm':False,'delete_token':saved['delete_token']}, {'confirm':True}]:
            self.assertEqual(self.client.delete(url,json=payload,headers={'X-Civic-Request':'1'}).status_code,400)
        self.assertTrue(path.is_file())
        usb=self.root/'usb.flac';usb.write_bytes(b'fLaC-USB-original')
        indexed=self.client.get('/api/library').json['tracks']
        external=next(t for t in indexed if t['origin']=='usb')
        self.assertEqual(self.client.delete('/api/library/'+external['id'],json={'confirm':True,'delete_token':'fake'},headers={'X-Civic-Request':'1'}).status_code,403)
        self.assertEqual(usb.read_bytes(),b'fLaC-USB-original')
        self.assertEqual(self.client.delete('/api/library/unknown',json={'confirm':True,'delete_token':'fake'},headers={'X-Civic-Request':'1'}).status_code,404)

    def test_delete_rejects_replaced_file_and_symlink_escapes(self):
        saved,path=self.saved_fixture()
        path.write_bytes(b'fLaC-new-file-with-different-content')
        self.assertEqual(self.delete_saved(saved).status_code,409)
        self.assertEqual(path.read_bytes(),b'fLaC-new-file-with-different-content')
        outside=self.root/'usb-original.flac';outside.write_bytes(b'fLaC-preserve-source')
        path.unlink();path.symlink_to(outside)
        self.assertEqual(self.delete_saved(saved).status_code,409)
        self.assertEqual(outside.read_bytes(),b'fLaC-preserve-source')
        path.unlink();path.write_bytes(b'fLaC-fixture-original')
        fresh=dashboard.describe_track(path)
        folder=path.parent;renamed=folder.with_name(folder.name+'-moved');folder.rename(renamed)
        external=self.root/'usb-folder';external.mkdir();(external/path.name).write_bytes(b'fLaC-external')
        folder.symlink_to(external,target_is_directory=True)
        self.assertEqual(self.delete_saved(fresh).status_code,409)
        self.assertEqual((external/path.name).read_bytes(),b'fLaC-external')
        self.assertEqual((renamed/path.name).read_bytes(),b'fLaC-fixture-original')

    def test_delete_does_not_race_library_scans_or_imports(self):
        track,path=self.saved_fixture()
        for lock in [dashboard._scan_lock,dashboard._import_lock]:
            lock.acquire()
            try:self.assertEqual(self.delete_saved(track).status_code,409)
            finally:lock.release()
            self.assertTrue(path.is_file())
        self.assertEqual(self.delete_saved(track).status_code,200)


if __name__ == '__main__':
    unittest.main()
