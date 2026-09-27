' agent2api status checker - shows whether the proxy is running and its health
Dim sh, fso
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

Dim home : home = Replace(WScript.ScriptFullName, "\status.vbs", "")
Dim pidFile : pidFile = home & "\run\proxy.pid"
Dim port : port = "9317" ' keep in sync with PORT in .env

If Not fso.FileExists(pidFile) Then
    MsgBox "agent2api is NOT running." & vbCrLf & "Run start.vbs to start it.", 64, "agent2api"
    WScript.Quit
End If

Dim pid : pid = Trim(fso.OpenTextFile(pidFile, 1).ReadAll())
Dim proc : Set proc = Nothing
On Error Resume Next
Set proc = GetObject("winmgmts:\\.\root\cimv2:Win32_Process.Handle='" & pid & "'")
On Error GoTo 0

If proc Is Nothing Then
    MsgBox "agent2api is NOT running (stale pid file).", 64, "agent2api"
    WScript.Quit
End If

Dim health
On Error Resume Next
Set exec = sh.Exec("curl -s --noproxy * -m 5 http://127.0.0.1:" & port & "/health")
health = exec.StdOut.ReadAll()
On Error GoTo 0

MsgBox "agent2api is RUNNING (pid " & pid & ")" & vbCrLf & _
       "Base URL : http://127.0.0.1:" & port & "/v1" & vbCrLf & _
       "Health   : " & health, 64, "agent2api"
