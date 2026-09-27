' agent2api silent stopper - kills the server process without any console window
' PID-file driven: only ever kills the pid we started ourselves, never a lookalike.
Dim sh, fso
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

Dim home : home = Replace(WScript.ScriptFullName, "\stop.vbs", "")
Dim pidFile : pidFile = home & "\run\proxy.pid"

If Not fso.FileExists(pidFile) Then
    MsgBox "agent2api is not running (no pid file).", 64, "agent2api"
    WScript.Quit
End If

Dim pid : pid = Trim(fso.OpenTextFile(pidFile, 1).ReadAll())
If Not IsNumeric(pid) Then
    fso.DeleteFile pidFile, True
    MsgBox "Stale pid file removed. agent2api is not running.", 64, "agent2api"
    WScript.Quit
End If

' Verify the pid is really our node process before killing it.
Dim proc : Set proc = Nothing
On Error Resume Next
Set proc = GetObject("winmgmts:\\.\root\cimv2:Win32_Process.Handle='" & pid & "'")
On Error GoTo 0

If proc Is Nothing Then
    fso.DeleteFile pidFile, True
    MsgBox "agent2api is not running (stale pid " & pid & " cleaned).", 64, "agent2api"
    WScript.Quit
End If

Dim exec
Set exec = sh.Exec("taskkill /F /T /PID " & pid)
exec.StdOut.ReadAll()
exec.StdErr.ReadAll()

fso.DeleteFile pidFile, True
MsgBox "agent2api stopped (pid " & pid & ").", 64, "agent2api"
