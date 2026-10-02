"""Best-effort Windows foregrounding, restricted to a newly created Edge window.

The PID comes from our dedicated CDP browser. Never focus an arbitrary Edge
window, simulate keystrokes, or permanently change topmost/system settings.
"""
import ctypes
from ctypes import wintypes
import sys


class WindowFocus:
    def __init__(self, pid):
        self.pid = int(pid)
        self.api = ctypes.WinDLL('user32', use_last_error=True) if sys.platform == 'win32' else None
        if self.api:
            a = self.api
            self.callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
            a.EnumWindows.argtypes = [self.callback_type, wintypes.LPARAM]
            a.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
            a.GetWindowThreadProcessId.restype = wintypes.DWORD
            a.IsWindowVisible.argtypes = [wintypes.HWND]
            a.IsIconic.argtypes = [wintypes.HWND]
            a.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
            a.GetForegroundWindow.restype = wintypes.HWND
            a.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
            a.SetForegroundWindow.argtypes = [wintypes.HWND]
            a.BringWindowToTop.argtypes = [wintypes.HWND]
            a.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
            a.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
        self.before = self.windows()
        self.status = 'not_attempted'

    def windows(self):
        if not self.api or self.pid <= 0:
            return set()
        found = set()
        @self.callback_type
        def visit(hwnd, _):
            pid = wintypes.DWORD()
            self.api.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            cls = ctypes.create_unicode_buffer(128)
            self.api.GetClassNameW(hwnd, cls, len(cls))
            if pid.value == self.pid and self.api.IsWindowVisible(hwnd) and cls.value == 'Chrome_WidgetWin_1':
                found.add(hwnd)
            return True
        self.api.EnumWindows(visit, 0)
        return found

    def activate(self):
        if not self.api:
            self.status = 'unsupported'
            return False
        candidates = self.windows() - self.before
        if len(candidates) != 1:
            self.status = 'window_not_identified'
            return False  # Ambiguous target: do not steal another window's focus.
        hwnd = candidates.pop()
        a = self.api
        if a.IsIconic(hwnd):
            a.ShowWindow(hwnd, 9)  # SW_RESTORE only if minimized.
        a.SetForegroundWindow(hwnd)
        if a.GetForegroundWindow() == hwnd:
            self.status = 'foreground'
            return True
        # User-triggered operation only; attach briefly and always detach.
        foreground = a.GetForegroundWindow()
        thread = a.GetWindowThreadProcessId(foreground, None) if foreground else 0
        current = ctypes.WinDLL('kernel32').GetCurrentThreadId()
        # A console worker has no GUI message queue by default. Windows refuses
        # AttachThreadInput until both threads have queues; create ours first.
        message = wintypes.MSG()
        a.PeekMessageW(ctypes.byref(message), None, 0, 0, 0)
        attached = bool(thread and thread != current and a.AttachThreadInput(current, thread, True))
        target_thread = a.GetWindowThreadProcessId(hwnd, None)
        target_attached = bool(target_thread and target_thread not in (current, thread) and a.AttachThreadInput(current, target_thread, True))
        try:
            if attached:
                a.BringWindowToTop(hwnd)
                a.SetForegroundWindow(hwnd)
            success = a.GetForegroundWindow() == hwnd
            self.status = 'foreground' if success else 'system_denied'
            return success
        finally:
            if target_attached:
                a.AttachThreadInput(current, target_thread, False)
            if attached:
                a.AttachThreadInput(current, thread, False)
