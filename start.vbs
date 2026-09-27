' agent2api silent launcher - no console window, runs in background
' Improvements over a plain launcher: PID-file based state check (port check alone
' can be fooled by another process), stale PID cleanup, and a distinct message
' when the port is occupied by something else.
' The port shown below is just the default from .env.example (PORT); edit if
' you changed PORT.
Dim sh, fso
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

Dim home : home = Replace(WScript.ScriptFullName, "\start.vbs", "")
sh.CurrentDirectory = home

Dim pidFile : pidFile = home & "\run\proxy.pid"

' --- Already running? -------------------------------------------------------
If fso.FileExists(pidFile) Then
    Dim oldPid : oldPid = Trim(fso.OpenTextFile(pidFile, 1).ReadAll())
    If IsNumeric(oldPid) Then
        Dim proc : Set proc = Nothing
        On Error Resume Next
        Set proc = GetObject("winmgmts:\\.\root\cimv2:Win32_Process.Handle='" & oldPid & "'")
        On Error GoTo 0
        If Not proc Is Nothing Then
            MsgBox "agent2api is already running (pid " & oldPid & ").", 64, "agent2api"
            WScript.Quit
        End If
    End If
    fso.DeleteFile pidFile, True ' stale pid file, clean it up
End If

' --- Port occupied by someone else? ------------------------------------------
Dim port : port = "9317" ' keep in sync with PORT in .env
Dim exec, out, occupied
Set exec = sh.Exec("netstat -ano")
out = exec.StdOut.ReadAll()
occupied = ""
Dim line, lines
lines = Split(out, vbCrLf)
For Each line In lines
    If InStr(line, "127.0.0.1:" & port) > 0 And InStr(line, "LISTENING") > 0 Then
        Dim parts, i
        parts = Split(Trim(line), " ")
        For i = UBound(parts) To 0 Step -1
            If Len(parts(i)) > 0 Then occupied = parts(i) : Exit For
        Next
        Exit For
    End If
Next
If occupied <> "" Then
    MsgBox "Port " & port & " is occupied by another process (pid " & occupied & ")." & vbCrLf & _
           "Stop it first or change PORT in .env.", 48, "agent2api"
    WScript.Quit
End If

' --- Preflight: .env must exist and have cookies set --------------------------
If Not fso.FileExists(home & "\.env") Then
    MsgBox ".env not found." & vbCrLf & _
           "Copy .env.example to .env and fill it from your own packet capture (see PROTOCOL.md).", 48, "agent2api"
    WScript.Quit
End If

' --- Start hidden, write pid file --------------------------------------------
If Not fso.FolderExists(home & "\run") Then fso.CreateFolder home & "\run"

' --- Tighten file permissions: .env and run/ only readable by the current user
' (after run/ exists, so a first-ever launch is covered too)
sh.Run "cmd /c icacls """ & home & "\.env"" /inheritance:r /grant:r ""%USERNAME%"":F 2>nul & icacls """ & home & "\run"" /inheritance:r /grant:r ""%USERNAME%"":(OI)(CI)F 2>nul", 0, True
sh.Run "cmd /c node src\index.js 1> run\proxy.out.log 2> run\proxy.err.log", 0, False
WScript.Sleep 1500

Set exec = sh.Exec("netstat -ano")
out = exec.StdOut.ReadAll()
Dim started : started = ""
lines = Split(out, vbCrLf)
For Each line In lines
    If InStr(line, "127.0.0.1:" & port) > 0 And InStr(line, "LISTENING") > 0 Then
        parts = Split(Trim(line), " ")
        For i = UBound(parts) To 0 Step -1
            If Len(parts(i)) > 0 And IsNumeric(parts(i)) Then started = parts(i) : Exit For
        Next
        Exit For
    End If
Next

If started = "" Then
    MsgBox "Failed to start. Check run\proxy.err.log.", 16, "agent2api"
    WScript.Quit
End If

fso.CreateTextFile(pidFile, True).Write started
MsgBox "agent2api started (pid " & started & ")" & vbCrLf & _
       "Base URL : http://127.0.0.1:" & port & "/v1" & vbCrLf & _
       "API key  : see .env (API_KEY)", 64, "agent2api"
