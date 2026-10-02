import importlib.util
from pathlib import Path
import types
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('window_focus', Path(__file__).resolve().parents[1] / 'local/window_focus.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WindowFocusTests(unittest.TestCase):
    def helper(self, windows, foreground):
        f = module.WindowFocus.__new__(module.WindowFocus)
        f.before = {1}
        f.windows = Mock(return_value=windows)
        f.api = Mock()
        f.api.GetForegroundWindow.return_value = foreground
        f.api.IsIconic.return_value = False
        return f

    def test_only_single_new_window_is_eligible(self):
        for windows in [{1}, {1, 2, 3}]:
            f = self.helper(windows, 1)
            self.assertFalse(f.activate())
            f.api.SetForegroundWindow.assert_not_called()

    def test_minimized_window_restored_and_verified(self):
        f = self.helper({1, 2}, 2)
        f.api.IsIconic.return_value = True
        self.assertTrue(f.activate())
        f.api.ShowWindow.assert_called_once_with(2, 9)
        f.api.SetForegroundWindow.assert_called_once_with(2)

    def test_system_denial_is_false_and_input_threads_detach(self):
        f = self.helper({1, 2}, 1)
        f.api.GetWindowThreadProcessId.return_value = 10
        f.api.AttachThreadInput.return_value = True
        with patch.object(module.ctypes, 'WinDLL', return_value=types.SimpleNamespace(GetCurrentThreadId=lambda: 20)):
            self.assertFalse(f.activate())
        self.assertEqual(f.api.AttachThreadInput.call_args_list[-1].args, (20, 10, False))


if __name__ == '__main__':
    unittest.main()
