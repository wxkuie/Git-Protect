using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

public class SetupForm : Form {
    ProgressBar bar;
    Label status;
    TextBox log;
    Button close;
    Button launch;
    string workDir;
    string installedExe;
    bool done;

    public SetupForm() {
        Text = "Git 静默提交助手 安装";
        ClientSize = new Size(520, 300);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.White;
        Font = new Font("Microsoft YaHei UI", 9F);

        Label title = new Label();
        title.Text = "正在安装 Git 静默提交助手";
        title.Font = new Font("Microsoft YaHei UI", 13F, FontStyle.Bold);
        title.SetBounds(24, 20, 460, 30);
        Controls.Add(title);

        status = new Label();
        status.Text = "准备中…";
        status.SetBounds(24, 58, 470, 40);
        status.ForeColor = Color.FromArgb(107, 114, 128);
        Controls.Add(status);

        bar = new ProgressBar();
        bar.SetBounds(24, 104, 472, 16);
        bar.Style = ProgressBarStyle.Continuous;
        Controls.Add(bar);

        log = new TextBox();
        log.Multiline = true;
        log.ReadOnly = true;
        log.ScrollBars = ScrollBars.Vertical;
        log.SetBounds(24, 132, 472, 96);
        log.BackColor = Color.FromArgb(246, 247, 249);
        log.BorderStyle = BorderStyle.FixedSingle;
        log.Font = new Font("Consolas", 8F);
        log.Visible = false;
        Controls.Add(log);

        launch = new Button();
        launch.Text = "启动程序";
        launch.SetBounds(300, 246, 96, 32);
        launch.Enabled = false;
        launch.Click += delegate { StartApp(); };
        Controls.Add(launch);

        close = new Button();
        close.Text = "关闭";
        close.SetBounds(404, 246, 92, 32);
        close.Click += delegate { Close(); };
        Controls.Add(close);
    }

    public bool Silent;

    protected override void OnShown(EventArgs e) {
        base.OnShown(e);
        System.Threading.ThreadPool.QueueUserWorkItem(delegate { Run(); });
    }

    void Ui(Action a) {
        if (Silent) return;
        try { BeginInvoke(a); } catch { }
    }

    // 测试用：不起窗口，直接跑安装逻辑，用退出码表示成败
    public void DoInstallForTest() {
        Run();
        Environment.Exit(done ? 0 : 1);
    }

    void SetStatus(string text) {
        if (Silent) Console.WriteLine(text);
        Trace(text);
        Ui(delegate { status.Text = text; });
    }

    void Trace(string text) {
        if (!Silent) return;
        try {
            File.AppendAllText(Path.Combine(Path.GetTempPath(), "gqh-setup-trace.log"), DateTime.Now.ToString("HH:mm:ss.fff ") + text + "\r\n");
        } catch { }
    }
    void ShowLog(string text) { Ui(delegate { log.Visible = true; log.Text = text; }); }

    void Run() {
        try {
            workDir = Path.Combine(Path.GetTempPath(), "GitQuietHelper-setup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(workDir);
            SetStatus("正在解压安装文件…");
            string zip = Path.Combine(workDir, "payload.zip");
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) {
                if (s == null) throw new Exception("安装包损坏：找不到内嵌数据");
                using (FileStream f = File.Create(zip)) {
                    byte[] buf = new byte[81920];
                    long total = s.Length, read = 0;
                    int n;
                    while ((n = s.Read(buf, 0, buf.Length)) > 0) {
                        f.Write(buf, 0, n);
                        read += n;
                        int pct = (int)(read * 100 / total);
                        Ui(delegate { bar.Value = pct > 100 ? 100 : pct; });
                    }
                }
            }
            SetStatus("正在展开文件…");
            string appDir = Path.Combine(workDir, "app");
            ZipFile.ExtractToDirectory(zip, appDir);
            File.Delete(zip);

            string installer = FindInstaller(appDir);
            if (installer == null) throw new Exception("安装包不完整：找不到 install.ps1");

            SetStatus("正在安装到本地…");
            Ui(delegate { bar.Style = ProgressBarStyle.Marquee; });
            string host = FindHost();
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = host;
            psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + installer + "\" -NoLaunch";
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            StringBuilder sb = new StringBuilder();
            using (Process p = Process.Start(psi)) {
                sb.Append(p.StandardOutput.ReadToEnd());
                sb.Append(p.StandardError.ReadToEnd());
                p.WaitForExit();
                Ui(delegate { bar.Style = ProgressBarStyle.Continuous; bar.Value = 100; });
                if (p.ExitCode != 0) {
                    throw new Exception("安装脚本返回 " + p.ExitCode + "\r\n" + sb.ToString());
                }
            }

            installedExe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "GitQuietHelper", "GitQuietHelper.exe");
            done = true;
            // 先把临时目录清干净，再用正确的工作目录启动：否则程序的工作目录指向一个马上被删的临时目录
            Cleanup();
            StartApp();
            SetStatus("安装完成。可以点「启动程序」直接运行。");
            Ui(delegate { launch.Enabled = true; launch.Focus(); });
        } catch (Exception ex) {
            SetStatus("安装失败：" + ex.Message.Split('\n')[0]);
            ShowLog(ex.ToString());
            Ui(delegate { bar.Style = ProgressBarStyle.Continuous; bar.Value = 0; });
        } finally {
            Cleanup();
        }
    }

    void Cleanup() {
        if (workDir == null) return;
        for (int i = 0; i < 5; i++) {
            try { Directory.Delete(workDir, true); return; } catch { System.Threading.Thread.Sleep(300); }
        }
    }

    void StartApp() {
        try {
            Trace("StartApp exe=" + installedExe + " exists=" + (installedExe != null && File.Exists(installedExe)));
            if (installedExe == null || !File.Exists(installedExe)) return;
            ProcessStartInfo si = new ProcessStartInfo();
            si.FileName = installedExe;
            si.WorkingDirectory = Path.GetDirectoryName(installedExe);
            si.UseShellExecute = true;
            Process pr = Process.Start(si);
            Trace("StartApp 已启动 pid=" + (pr == null ? -1 : pr.Id));
        } catch (Exception ex) { Trace("StartApp 异常: " + ex.Message); }
    }

    static string FindInstaller(string dir) {
        string[] hits = Directory.GetFiles(dir, "install.ps1", SearchOption.AllDirectories);
        return hits.Length > 0 ? hits[0] : null;
    }

    static string FindHost() {
        string[] names = new string[] { "pwsh.exe", "powershell.exe" };
        string[] dirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';');
        for (int i = 0; i < names.Length; i++) {
            for (int j = 0; j < dirs.Length; j++) {
                if (dirs[j].Length == 0) continue;
                try {
                    string p = Path.Combine(dirs[j], names[i]);
                    if (File.Exists(p)) return p;
                } catch { }
            }
        }
        string sys = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell\\v1.0\\powershell.exe");
        return File.Exists(sys) ? sys : "powershell.exe";
    }
}

public static class Program {
    [STAThread]
    public static void Main(string[] args) {
        bool silent = Array.IndexOf(args, "--silent") >= 0;
        string shot = null;
        int si = Array.IndexOf(args, "--shot");
        if (si >= 0 && si + 1 < args.Length) shot = args[si + 1];
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        SetupForm form = new SetupForm();
        if (shot != null) {
            // 验收外观用：摆到屏幕外画出来，屏幕上不会出现
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(-4000, -4000);
            form.Show();
            Application.DoEvents();
            System.Threading.Thread.Sleep(400);
            Bitmap bmp = new Bitmap(form.Width, form.Height);
            form.DrawToBitmap(bmp, new Rectangle(0, 0, bmp.Width, bmp.Height));
            bmp.Save(shot, System.Drawing.Imaging.ImageFormat.Png);
            bmp.Dispose();
            form.Close();
            return;
        }
        if (silent) {
            form.Silent = true;
            form.DoInstallForTest();
            return;
        }
        Application.Run(form);
    }
}