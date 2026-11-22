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


if __name__ == '__main__':
    unittest.main()
