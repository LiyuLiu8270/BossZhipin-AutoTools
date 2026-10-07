using System;
using System.Threading;

namespace Xunxu {
    internal static class DesktopTests {
        static int Main(string[] args) {
            Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            try {
                if (args[0] == "quote") { Console.Write(ServiceClient.Quote(args[1])); return 0; }
                if (args[0] == "root") { Console.Write(Program.FindRoot(args[1])); return 0; }
                if (args[0] == "node-selection") {
                    int checks = 0;
                    string rejectedNode = System.IO.Path.GetFullPath(args[1]), currentNode = System.IO.Path.GetFullPath(args[2]);
                    string selected = ServiceClient.FindNode(new[] { "relative.exe", args[1], args[1].ToUpperInvariant(), args[2] }, delegate(string path) { checks++; return String.Equals(path, currentNode, StringComparison.OrdinalIgnoreCase); });
                    if (!String.Equals(selected, currentNode, StringComparison.OrdinalIgnoreCase) || checks != 2) throw new Exception("node_selection_failed");
                    selected = ServiceClient.FindNode(new[] { args[1], args[2] }, delegate(string path) { if (String.Equals(path, rejectedNode, StringComparison.OrdinalIgnoreCase)) throw new Exception("broken_candidate"); return true; });
                    if (!String.Equals(selected, currentNode, StringComparison.OrdinalIgnoreCase)) throw new Exception("node_fallback_failed");
                    bool rejected = false;
                    try { ServiceClient.FindNode(new[] { args[1] }, delegate(string path) { return false; }); } catch (InvalidOperationException) { rejected = true; }
                    if (!rejected || !ServiceClient.SupportedNode(args[2])) throw new Exception("node_version_check_failed");
                    Console.Write("supported_fallback_deduped"); return 0;
                }
                var client = new ServiceClient(args[1], int.Parse(args[2]));
                if (args[0] == "probe") { Console.Write(client.Healthy() ? "healthy" : "unverified"); return 0; }
                if (args[0] == "alerts") { if (!client.Healthy()) throw new Exception("not_healthy"); Console.Write(client.UnreadAlerts + ":" + client.LatestAlert); return 0; }
                if (args[0] == "stop") { client.Stop(); Console.Write("stopping"); return 0; }
                if (args[0] == "start") {
                    using (var child = client.Start()) {
                        for (int i = 0; i < 30 && !client.Healthy(); i++) Thread.Sleep(100);
                        if (!client.Healthy()) throw new Exception("fixture_not_ready");
                        bool blocked = false;
                        try { client.Start(); } catch (InvalidOperationException) { blocked = true; }
                        if (!blocked) throw new Exception("duplicate_service");
                        client.Stop();
                        if (!child.WaitForExit(5000)) throw new Exception("fixture_not_stopped");
                        Console.Write("started_hidden_duplicate_blocked_stopped:" + child.StartInfo.CreateNoWindow + ":" + child.StartInfo.UseShellExecute);
                    }
                    return 0;
                }
                throw new Exception("bad_test_command");
            } catch (Exception e) { Console.Error.Write(e.GetType().Name + ":" + e.Message); return 1; }
        }
    }
}
