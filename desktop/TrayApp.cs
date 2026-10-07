using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("循序 · 求职助手")]
[assembly: AssemblyDescription("本地服务与托盘入口")]
[assembly: AssemblyVersion("1.7.1.0")]

namespace Xunxu {
    internal static class Diagnostic {
        internal static void Write(string root, string message) {
            try { Directory.CreateDirectory(Path.Combine(root,"local","data")); File.AppendAllText(Path.Combine(root,"local","data","desktop.log"),DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine,Encoding.UTF8); } catch { }
        }
    }
    // No browser storage, database, model or collection settings are written by this shell.
    internal sealed class ServiceClient {
        internal readonly string Root;
        internal readonly int Port;
        internal string LatestAlert = "";
        internal int UnreadAlerts;
        internal string Address { get { return "http://127.0.0.1:" + Port + "/"; } }
        internal ServiceClient(string root, int port) { Root = root; Port = port; }
        internal Dictionary<string, object> Request(string route, bool post) {
            string token = File.ReadAllText(Path.Combine(Root, "local", "data", "service-token.txt")).Trim();
            if (!Regex.IsMatch(token, "\\A[a-f0-9]{64}\\z")) throw new InvalidOperationException("服务令牌不可用。");
            var request = (HttpWebRequest)WebRequest.Create(Address + route);
            request.Proxy = null;
            request.AllowAutoRedirect = false;
            request.KeepAlive = false; // Health polling must not hold shutdown open.
            request.Timeout = 2500; request.ReadWriteTimeout = 2500;
            request.Headers["X-Service-Token"] = token;
            request.Method = post ? "POST" : "GET";
            if (post) request.ContentLength = 0;
            using (var response = (HttpWebResponse)request.GetResponse()) {
                if (response.StatusCode != HttpStatusCode.OK) throw new InvalidOperationException("服务未确认请求。");
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    var json = new JavaScriptSerializer { MaxJsonLength = 131072 };
                    return json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                }
            }
        }
        internal bool Healthy() {
            try {
                var data = Request("health", false);
                object alerts;
                if (data.TryGetValue("communicationAlerts", out alerts)) {
                    var a = alerts as Dictionary<string, object>;
                    if (a != null && a.ContainsKey("latestId") && a.ContainsKey("unread")) {
                        LatestAlert = Convert.ToString(a["latestId"]); UnreadAlerts = Convert.ToInt32(a["unread"]);
                    }
                }
                // The private token authenticates the pre-tray 0.10 service as well.
                return data.ContainsKey("ok") && data["ok"] is bool && (bool)data["ok"]
                    && data.ContainsKey("states") && data.ContainsKey("daily_limit");
            } catch { return false; }
        }
        internal bool PortOpen() {
            using (var socket = new TcpClient()) {
                try {
                    var result = socket.BeginConnect("127.0.0.1", Port, null, null);
                    using (result.AsyncWaitHandle) {
                        if (!result.AsyncWaitHandle.WaitOne(600)) return false;
                        socket.EndConnect(result); return true;
                    }
                } catch { return false; }
            }
        }
        internal void Stop() {
            var data = Request("stop", true);
            if (!data.ContainsKey("ok") || !Equals(data["ok"], true)
                || !data.ContainsKey("status") || !(Equals(data["status"], "stopping_after_current_batch") || Equals(data["status"], "stopping_after_inflight")))
                throw new InvalidOperationException("服务没有确认停止请求；未强制结束进程。");
        }
        internal static string FindNode() {
            // Prefer a separately installed runtime, not an IDE-injected PATH runtime.
            string fallback = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
            if (File.Exists(fallback)) return fallback;
            foreach (string raw in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
                try {
                    string path = Path.Combine(raw.Trim().Trim('"'), "node.exe");
                    if (Path.IsPathRooted(path) && File.Exists(path)) return path;
                } catch { }
            }
            throw new InvalidOperationException("没有找到 Node.js。请安装 Node.js 24 或更高版本后重试。");
        }
        internal static string Quote(string value) {
            var result = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value) {
                if (c == '\\') { slashes++; continue; }
                result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
                result.Append(c); slashes = 0;
            }
            result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
        }
        internal Process Start() {
            if (PortOpen()) throw new InvalidOperationException("端口已被占用，未启动重复服务。请查看托盘运行状态。");
            string script = Path.Combine(Root, "local", "automation.mjs");
            if (!File.Exists(script)) throw new InvalidOperationException("找不到服务文件，请将应用放回原工作目录。");
            string node = FindNode();
            using (var check = Process.Start(new ProcessStartInfo(node, "--version") {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true
            })) {
                if (!check.WaitForExit(4000)) throw new InvalidOperationException("Node.js 启动检查超时。");
                var match = Regex.Match(check.StandardOutput.ReadToEnd(), "^v(\\d+)\\.");
                if (!match.Success || int.Parse(match.Groups[1].Value) < 24)
                    throw new InvalidOperationException("需要 Node.js 24 或更高版本。");
            }
            Directory.CreateDirectory(Path.Combine(Root, "local", "data"));
            var child = new Process { StartInfo = new ProcessStartInfo(node, Quote(script) + " serve") {
                WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            }};
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log("web-service.log", e.Data); };
            child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log("web-service-error.log", e.Data); };
            child.EnableRaisingEvents = true;
            child.Exited += delegate { try { Diagnostic.Write(Root, "service_exit pid=" + child.Id + " code=" + child.ExitCode); } catch { } };
            child.Start(); child.BeginOutputReadLine(); child.BeginErrorReadLine();
            Diagnostic.Write(Root, "service_start pid=" + child.Id + " node=" + node);
            return child;
        }
        readonly object logLock = new object();
        void Log(string name, string line) {
            if (line == null) return;
            try { lock (logLock) File.AppendAllText(Path.Combine(Root, "local", "data", name), line + Environment.NewLine, Encoding.UTF8); }
            catch { /* A full disk must not crash the tray and disconnect a running service. */ }
        }
    }

    internal sealed class TrayContext : ApplicationContext {
        readonly ServiceClient service;
        readonly NotifyIcon tray;
        readonly ToolStripMenuItem stateItem, startItem, openItem, exitItem;
        readonly System.Windows.Forms.Timer timer;
        readonly EventWaitHandle activate;
        readonly Icon icon;
        Process child;
        bool busy, stopping, exitWhenStopped, healthy, warned, disposed;
        int closedChecks;
        string lastNotifiedAlert = "";
        DateTime stopStarted;
        string state = "正在连接服务…";
        internal TrayContext(string root, EventWaitHandle signal) {
            service = new ServiceClient(root, 17321); activate = signal;
            icon = MakeIcon();
            var menu = new ContextMenuStrip();
            stateItem = new ToolStripMenuItem(state) { Enabled = false };
            openItem = new ToolStripMenuItem("打开控制台", null, async delegate { await OpenConsole(); });
            startItem = new ToolStripMenuItem("启动服务", null, async delegate { await Start(false); });
            exitItem = new ToolStripMenuItem("停止服务并退出", null, async delegate { await Quit(); });
            menu.Items.Add(openItem); menu.Items.Add(new ToolStripSeparator()); menu.Items.Add(stateItem);
            menu.Items.Add("查看运行状态", null, delegate { ShowStatus(); });
            menu.Items.Add(startItem);
            menu.Items.Add("打开日志文件夹", null, delegate { OpenPath(Path.Combine(root, "local", "data")); });
            menu.Items.Add(new ToolStripSeparator()); menu.Items.Add(exitItem);
            tray = new NotifyIcon { Icon = icon, Text = "循序 · 求职助手", ContextMenuStrip = menu, Visible = true };
            tray.DoubleClick += async delegate { await OpenConsole(); };
            tray.BalloonTipClicked += async delegate { await OpenConsole(); };
            timer = new System.Windows.Forms.Timer { Interval = 2000 };
            timer.Tick += async delegate {
                if (busy) return;
                if (activate.WaitOne(0)) { await OpenConsole(); return; }
                await Poll();
            };
            timer.Start();
            // First tick starts/attaches once; never automatically relaunch a crashed service.
            EventHandler first = null;
            first = async delegate { Application.Idle -= first; await Start(true); };
            Application.Idle += first;
        }
        internal static Icon MakeIcon() {
            using (var bitmap = new Bitmap(32, 32)) {
                using (var g = Graphics.FromImage(bitmap)) {
                    g.Clear(Color.Transparent);
                    g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                    using (var brush = new SolidBrush(Color.FromArgb(18, 116, 105))) g.FillEllipse(brush, 1, 1, 30, 30);
                    using (var pen = new Pen(Color.White, 3)) {
                        g.DrawLines(pen, new Point[] { new Point(8, 17), new Point(14, 23), new Point(25, 10) });
                    }
                }
                IntPtr h = bitmap.GetHicon();
                try { using (var temporary = Icon.FromHandle(h)) return (Icon)temporary.Clone(); }
                finally { DestroyIcon(h); }
            }
        }
        [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);
        void SetState(string value) {
            if (disposed) return;
            if (state != value) Diagnostic.Write(service.Root, "state=" + value);
            state = value; stateItem.Text = value;
            tray.Text = "循序 · " + value;
            try {
                var snapshot = new Dictionary<string, object> {
                    {"pid", Process.GetCurrentProcess().Id}, {"state", value}, {"healthy", healthy},
                    {"trayVisible", tray.Visible}, {"stopping", stopping}, {"ownsService", child != null},
                    {"version", Assembly.GetExecutingAssembly().GetName().Version.ToString()}, {"at", DateTime.UtcNow.ToString("o")}
                };
                File.WriteAllText(Path.Combine(service.Root,"local","data","desktop-status.json"),new JavaScriptSerializer().Serialize(snapshot),Encoding.UTF8);
            } catch { }
            startItem.Enabled = !busy && !stopping && !healthy;
            openItem.Enabled = !stopping;
            exitItem.Enabled = !busy && !stopping;
        }
        async Task Start(bool open) {
            if (busy || stopping) return;
            busy = true; SetState("正在连接服务…");
            try {
                healthy = await Task.Run(() => service.Healthy());
                if (healthy && !stopping && service.UnreadAlerts > 0 && service.LatestAlert != lastNotifiedAlert) {
                    lastNotifiedAlert = service.LatestAlert;
                    tray.ShowBalloonTip(8000, "循序 · 沟通提醒", "有新的 HR 回复或沟通需要处理，点击打开控制台。", ToolTipIcon.Info);
                }
                if (!healthy) {
                    if (child != null && !child.HasExited)
                        throw new InvalidOperationException("服务进程仍在运行但暂未响应。请查看日志，不会重复启动。");
                    child = await Task.Run(() => service.Start());
                    for (int i = 0; i < 30; i++) {
                        healthy = await Task.Run(() => service.Healthy());
                        if (healthy) break;
                        if (child.HasExited) throw new InvalidOperationException("服务启动失败，请查看日志文件夹中的 web-service-error.log。");
                        await Task.Delay(500);
                    }
                    if (!healthy) throw new InvalidOperationException("服务尚未就绪，托盘会继续检查。请勿重复启动。");
                }
                SetState("服务运行中");
                if (open) OpenPath(service.Address);
                tray.ShowBalloonTip(3500, "循序 · 求职助手", "已在后台运行。右键托盘图标打开控制台或退出。", ToolTipIcon.Info);
            } catch (Exception e) {
                Diagnostic.Write(service.Root,"start: " + e.GetType().Name + " " + e.Message);
                SetState("服务未就绪");
                MessageBox.Show(e is InvalidOperationException ? e.Message : "启动失败，请检查项目位置、Node.js 和本地服务日志。", "循序 · 求职助手", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            } finally { busy = false; SetState(state); }
        }
        async Task OpenConsole() {
            if (busy || stopping) return;
            busy = true;
            try {
                healthy = await Task.Run(() => service.Healthy());
                if (healthy) OpenPath(service.Address);
                else { SetState("服务未就绪"); ShowStatus(); }
            } finally { busy = false; SetState(state); }
        }
        void ShowStatus() {
            MessageBox.Show("状态：" + state + "\n控制台：" + service.Address
                + "\n\n关闭网页后服务继续运行；退出托盘将正常停止服务。"
                + "\n服务运行不代表正在采集或匹配，具体任务请在控制台查看。"
                + "\n数据、队列和设置保存在原目录，不会因退出删除。", "循序 · 运行状态", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        void OpenPath(string path) {
            try { Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); }
            catch (Exception e) { Diagnostic.Write(service.Root,"open: " + e.GetType().Name + " " + e.Message); MessageBox.Show("无法打开，请手动访问：\n" + path, "循序 · 求职助手"); }
        }
        async Task Quit() {
            if (busy || stopping) return;
            busy = true; SetState("正在确认服务状态…");
            try {
                healthy = await Task.Run(() => service.Healthy());
                if (!healthy) {
                    if (await Task.Run(() => service.PortOpen()) || (child != null && !child.HasExited)) {
                        if (child == null || child.HasExited) {
                            if (MessageBox.Show("端口上的服务无法确认，未发送停止命令。是否只关闭托盘、保留现有进程？", "循序 · 服务未确认", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes) ExitThread();
                            return;
                        }
                        MessageBox.Show("服务当前未通过健康检查，不能确认任务是否结束。未强制关闭，请检查日志后再试。", "循序 · 暂不能退出"); return;
                    }
                    ExitThread(); return;
                }
                // Do not retry POST on ambiguous acknowledgement. Observe until port and owned process close.
                stopping = true; exitWhenStopped = true; stopStarted = DateTime.UtcNow;
                try { await Task.Run(() => service.Stop()); }
                catch { tray.ShowBalloonTip(5000, "正在确认停止结果", "停止请求未确认；不会重复发送或强杀进程。请查看控制台/日志。", ToolTipIcon.Warning); }
                SetState("正在停止，等待当前任务结束…");
            } finally { busy = false; SetState(state); }
        }
        async Task Poll() {
            busy = true;
            try {
                healthy = await Task.Run(() => service.Healthy());
                bool port = healthy || await Task.Run(() => service.PortOpen());
                bool childRunning = child != null && !child.HasExited;
                if (stopping) {
                    closedChecks = !port && !childRunning ? closedChecks + 1 : 0;
                    if (closedChecks >= 3 && exitWhenStopped) { ExitThread(); return; }
                    if (!warned && (DateTime.UtcNow - stopStarted).TotalSeconds > 60) {
                        warned = true;
                        tray.ShowBalloonTip(8000, "仍在等待服务退出", "任务尚未确认结束，托盘会继续等待；不会强制结束进程。", ToolTipIcon.Warning);
                    }
                } else SetState(healthy ? "服务运行中" : (port || childRunning ? "服务无响应，请查看日志" : "服务已停止，可右键启动"));
            } finally { busy = false; SetState(state); }
        }
        protected override void ExitThreadCore() {
            Diagnostic.Write(service.Root, "tray_exit stopping=" + stopping + " ownsService=" + (child != null));
            disposed = true;
            timer.Stop(); timer.Dispose(); tray.Visible = false; tray.Dispose(); icon.Dispose();
            if (child != null) child.Dispose();
            base.ExitThreadCore();
        }
    }
    internal static class Program {
        internal static string FindRoot(string directory) {
            string[] candidates = { directory, Path.GetFullPath(Path.Combine(directory, "..")) };
            foreach (string path in candidates)
                if (File.Exists(Path.Combine(path, "local", "automation.mjs"))) return path;
            throw new InvalidOperationException("找不到求职助手服务目录。请将 EXE 放在包含 local 目录的项目根目录中。");
        }
        [STAThread] static void Main(string[] args) {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            if (args.Length == 2 && args[0] == "--write-icon") {
                using (var icon = TrayContext.MakeIcon()) using (var file = File.Create(args[1])) icon.Save(file);
                return;
            }
            bool created;
            using (var mutex = new Mutex(true, "Local\\XunxuJobAssistant17321", out created))
            using (var signal = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\XunxuJobAssistantOpen17321")) {
                if (!created) { signal.Set(); return; }
                try {
                    Diagnostic.Write(FindRoot(AppDomain.CurrentDomain.BaseDirectory), "tray_start pid=" + Process.GetCurrentProcess().Id + " version=" + Assembly.GetExecutingAssembly().GetName().Version);
                    Application.Run(new TrayContext(FindRoot(AppDomain.CurrentDomain.BaseDirectory), signal));
                }
                catch (Exception e) {
                    try { Diagnostic.Write(FindRoot(AppDomain.CurrentDomain.BaseDirectory), "main: " + e.GetType().Name + " " + e.Message); } catch { }
                    MessageBox.Show("应用无法启动，请确认它仍在原工作目录，并检查本地服务日志。", "循序 · 求职助手", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
    }
}
