// Isolated acceptance fixture. Does not load any production data or service.
using System;
using System.IO;
using System.Diagnostics;
using System.Management;
using System.Threading;
class LauncherFixture {
 static void Main() {
  string root=AppDomain.CurrentDomain.BaseDirectory;
  int pid=Process.GetCurrentProcess().Id,parent=0;string name="unknown";
  using(var query=new ManagementObjectSearcher("SELECT ParentProcessId FROM Win32_Process WHERE ProcessId="+pid))foreach(ManagementObject p in query.Get())parent=Convert.ToInt32(p["ParentProcessId"]);
  try{name=Process.GetProcessById(parent).ProcessName;}catch{}
  File.WriteAllText(Path.Combine(root,"started.txt"),pid+"\n"+parent+"\n"+name);
  for(int i=0;i<200&&!File.Exists(Path.Combine(root,"stop"));i++){File.WriteAllText(Path.Combine(root,"heartbeat.txt"),DateTime.UtcNow.ToString("o"));Thread.Sleep(100);}
  File.WriteAllText(Path.Combine(root,"stopped.txt"),"normal_exit");
 }
}
