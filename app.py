"""Local Civic infotainment UI, mounted music, and persistent onboard imports."""
import errno
import hashlib
import os
import stat
import shutil
import tempfile
import threading
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename

app = Flask(__name__)
from audio_bridge import register_audio_bridge
register_audio_bridge(app)
from vehicle_diagnostics import register_vehicle_diagnostics
register_vehicle_diagnostics(app)
from lighting import register_lighting
register_lighting(app)
AUDIO_EXTENSIONS = {'.flac', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.aiff', '.aif'}
MAX_LIBRARY_TRACKS = 10000
MAX_IMPORT_BYTES = 1024 * 1024 * 1024
STORAGE_RESERVE_BYTES = 128 * 1024 * 1024
app.config['MAX_CONTENT_LENGTH'] = MAX_IMPORT_BYTES + 1024 * 1024
_library = {}
_library_lock = threading.Lock()
_scan_lock = threading.Lock()
_import_lock = threading.Lock()


def onboard_root():
    return Path(os.environ.get('CIVIC_LIBRARY_DIR',
                               str(Path(app.root_path) / 'data' / 'music'))).expanduser().resolve()


def library_roots():
    roots = music_roots()
    onboard = onboard_root()
    if onboard.is_dir() and onboard not in roots:
        roots.insert(0, onboard)
    return roots


def track_version(info):
    identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    return hashlib.sha256(repr(identity).encode('ascii')).hexdigest()


def describe_track(path):
    track_id = hashlib.sha256(os.fsencode(path)).hexdigest()[:24]
    origin = 'onboard' if path.is_relative_to(onboard_root()) else 'usb'
    token = None
    if origin == 'onboard':
        try:
            info = os.stat(path, follow_symlinks=False)
            if stat.S_ISREG(info.st_mode):
                token = track_version(info)
        except OSError:
            pass
    return dict(id=track_id, delete_token=token, title=path.stem.replace('_', ' '),
                artist='Onboard library' if origin == 'onboard' else 'USB library',
                album='', origin=origin, format=path.suffix[1:].upper(),
                url=f'/api/media/{track_id}', metadata_url=f'/api/media/{track_id}')


def index_track(path):
    track = describe_track(path)
    with _library_lock:
        _library[track['id']] = path
    return track


class ImportFailure(Exception):
    def __init__(self, message, status):
        self.message = message
        self.status = status


def save_onboard(stream, filename, expected_size=None):
    """Stream an exact copy, deduplicate by SHA-256, and expose only complete files."""
    filename = secure_filename(filename or '')
    if not filename or Path(filename).suffix.lower() not in AUDIO_EXTENSIONS:
        raise ImportFailure('Choose a supported music file.', 400)
    if expected_size is not None and expected_size > MAX_IMPORT_BYTES:
        raise ImportFailure('Each saved track must be 1 GiB or smaller.', 413)
    root = onboard_root()
    if os.environ.get('CIVIC_LIBRARY_DIR') and not root.parent.is_dir():
        raise ImportFailure('Onboard storage is unavailable. Check the configured drive.', 503)
    root.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(root).free
    if free < (expected_size or 0) + STORAGE_RESERVE_BYTES:
        raise ImportFailure('Not enough onboard space. 128 MiB is reserved for the system.', 507)
    temporary = None
    try:
        digest = hashlib.sha256()
        size = 0
        with tempfile.NamedTemporaryFile(prefix='.import-', dir=root, delete=False) as target:
            temporary = Path(target.name)
            while chunk := stream.read(256 * 1024):
                size += len(chunk)
                if size > MAX_IMPORT_BYTES:
                    raise ImportFailure('Each saved track must be 1 GiB or smaller.', 413)
                if size > free - STORAGE_RESERVE_BYTES:
                    raise ImportFailure('Not enough onboard space to finish this copy.', 507)
                target.write(chunk)
                digest.update(chunk)
            if not size:
                raise ImportFailure('This music file is empty.', 400)
            if expected_size is not None and size != expected_size:
                raise ImportFailure('The source changed during copying. Reconnect and try again.', 409)
            target.flush()
            os.fsync(target.fileno())
        folder = root / digest.hexdigest()
        if folder.is_symlink():
            raise ImportFailure('The destination folder is unavailable.', 409)
        folder.mkdir(exist_ok=True)
        # Existing content with the same digest is already an exact saved copy.
        existing = next((p for p in folder.iterdir()
                         if not p.is_symlink() and p.is_file()
                         and p.suffix.lower() in AUDIO_EXTENSIONS), None)
        if existing:
            return index_track(existing), True
        destination = folder / filename
        os.replace(temporary, destination)
        temporary = None
        return index_track(destination), False
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def music_roots():
    """Override defaults with CIVIC_MUSIC_DIRS, separated by the OS path separator."""
    configured = os.environ.get('CIVIC_MUSIC_DIRS')
    values = configured.split(os.pathsep) if configured else ['/media', '/run/media', '/mnt']
    roots = []
    for value in values:
        if not value.strip():
            continue
        try:
            root = Path(value).expanduser().resolve(strict=True)
            if root.is_dir() and root not in roots:
                roots.append(root)
        except (OSError, RuntimeError):
            continue
    return roots


def allowed_path(path, roots):
    try:
        resolved = path.resolve(strict=True)
        return (resolved if resolved.is_file()
                and resolved.suffix.lower() in AUDIO_EXTENSIONS
                and any(resolved.is_relative_to(root) for root in roots) else None)
    except (OSError, RuntimeError):
        return None


@app.get('/')
def index():
    return render_template('index.html')


@app.get('/api/library')
def library():
    """Scan mounted storage without accepting arbitrary client-supplied paths."""
    global _library
    if not _scan_lock.acquire(blocking=False):
        return jsonify(error='A USB scan is already running. Try again shortly.'), 409
    try:
        roots = library_roots()
        found = {}
        truncated = False
        inaccessible = 0
        # An explicit stack avoids following directory symlinks and bounds recursion depth.
        stack = [(root, 0) for root in roots]
        visited = set()
        while stack and not truncated:
            directory, depth = stack.pop()
            if depth > 24 or directory in visited:
                continue
            visited.add(directory)
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        if entry.name.startswith('.') or entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            stack.append((Path(entry.path), depth + 1))
                            continue
                        if Path(entry.name).suffix.lower() not in AUDIO_EXTENSIONS:
                            continue
                        path = allowed_path(Path(entry.path), roots)
                        if path is None:
                            continue
                        track_id = hashlib.sha256(os.fsencode(path)).hexdigest()[:24]
                        if track_id not in found and len(found) >= MAX_LIBRARY_TRACKS:
                            truncated = True
                            break
                        found[track_id] = path
            except (OSError, RuntimeError):
                inaccessible += 1
        with _library_lock:
            _library = found
        tracks = [describe_track(path) for path in found.values()]
        tracks.sort(key=lambda item: item['title'].casefold())
        return jsonify(tracks=tracks, truncated=truncated,
                       limit=MAX_LIBRARY_TRACKS, inaccessible=inaccessible,
                       onboard_count=sum(t['origin'] == 'onboard' for t in tracks))
    finally:
        _scan_lock.release()


@app.get('/api/media/<track_id>')
def media(track_id):
    with _library_lock:
        path = _library.get(track_id)
    if path is None:
        return jsonify(error='Track not indexed. Scan the USB library again.'), 404
    # Revalidate at playback time in case a device was removed or a path changed.
    resolved = allowed_path(path, library_roots())
    if resolved is None:
        return jsonify(error='Music file unavailable. Check the USB drive and scan again.'), 404
    try:
        return send_file(resolved, conditional=True)
    except OSError:
        return jsonify(error='The USB drive was disconnected.'), 404


@app.post('/api/library/import')
def import_music():
    # A custom header prevents cross-origin HTML forms from initiating disk writes.
    if request.headers.get('X-Civic-Request') != '1':
        return jsonify(error='Use Save to Pi from this dashboard.'), 403
    if not _import_lock.acquire(blocking=False):
        return jsonify(error='A music copy is already running. Try again shortly.'), 409
    try:
        if request.is_json:
            track_id = (request.get_json(silent=True) or {}).get('track_id')
            if not isinstance(track_id, str):
                raise ImportFailure('Select a music track first.', 400)
            with _library_lock:
                path = _library.get(track_id)
            source = allowed_path(path, library_roots()) if path is not None else None
            if source is None:
                raise ImportFailure('Source unavailable. Reconnect your drive and scan again.', 404)
            if source.is_relative_to(onboard_root()):
                return jsonify(track=index_track(source), already_saved=True), 200
            with source.open('rb') as stream:
                track, duplicate = save_onboard(stream, source.name, source.stat().st_size)
        else:
            upload = request.files.get('file')
            if upload is None:
                raise ImportFailure('Choose a music file first.', 400)
            track, duplicate = save_onboard(upload.stream, upload.filename)
        return jsonify(track=track, already_saved=duplicate), 200 if duplicate else 201
    except ImportFailure as error:
        return jsonify(error=error.message), error.status
    except OSError as error:
        message = ('Not enough onboard storage.' if error.errno == errno.ENOSPC else
                   'The copy failed. Check your source and onboard storage, then try again.')
        return jsonify(error=message), 507 if error.errno == errno.ENOSPC else 503
    finally:
        _import_lock.release()


@app.delete('/api/library/<track_id>')
def delete_onboard_music(track_id):
    """Delete one confirmed indexed onboard file; never follow a link to USB."""
    if request.remote_addr not in ('127.0.0.1', '::1') or request.headers.get('X-Civic-Request') != '1':
        return jsonify(error='Use Delete from Pi on the dashboard.'), 403
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or payload.get('confirm') is not True or not isinstance(payload.get('delete_token'), str):
        return jsonify(error='Confirm the selected saved file before deleting it.'), 400
    if not _scan_lock.acquire(blocking=False):
        return jsonify(error='The library is being scanned. Try again shortly.'), 409
    copying = False
    descriptors = []
    try:
        copying = _import_lock.acquire(blocking=False)
        if not copying:
            return jsonify(error='A music copy is running. Try again shortly.'), 409
        with _library_lock:
            path = _library.get(track_id)
        if path is None:
            return jsonify(error='Track not indexed. Scan the library again.'), 404
        root = onboard_root()
        try:
            relative = path.relative_to(root)
        except ValueError:
            return jsonify(error='Only files saved on the Pi can be deleted here.'), 403
        if not relative.parts or '..' in relative.parts or path.suffix.lower() not in AUDIO_EXTENSIONS:
            return jsonify(error='Invalid saved music file.'), 403
        # Pin each parent directory and refuse symlinks. A renamed/replaced parent
        # cannot redirect unlink to a USB source or another folder outside the library.
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(directory)
        for part in relative.parts[:-1]:
            directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            descriptors.append(directory)
        info = os.stat(relative.name, dir_fd=directory, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode):
            return jsonify(error='This file changed. Scan the library again.'), 409
        if track_version(info) != payload['delete_token']:
            return jsonify(error='This file changed. Scan the library and select it again.'), 409
        os.unlink(relative.name, dir_fd=directory)
        with _library_lock:
            _library.pop(track_id, None)
        return jsonify(deleted=True, track_id=track_id)
    except FileNotFoundError:
        return jsonify(error='This saved file is no longer available. Scan the library again.'), 404
    except OSError:
        return jsonify(error='Could not delete this file. Check onboard storage and scan again.'), 409
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)
        if copying:
            _import_lock.release()
        _scan_lock.release()


@app.errorhandler(RequestEntityTooLarge)
def import_too_large(error):
    return jsonify(error='Each saved track must be 1 GiB or smaller.'), 413


if __name__ == '__main__':
    app.run(host=os.environ.get('CIVIC_HOST', '127.0.0.1'),
            port=int(os.environ.get('CIVIC_PORT', '5000')), debug=False)
