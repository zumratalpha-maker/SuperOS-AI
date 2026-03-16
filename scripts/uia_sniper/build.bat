@echo off
REM 编译 UiaSniper.exe（需 Windows + .NET Framework 4.x）
set REF="C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8"
if not exist %REF% set REF="C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.7.2"
set FW64="C:\Windows\Microsoft.NET\Framework64\v4.0.30319"
set WPF=%FW64%\WPF
if not exist %REF% (
  echo Reference Assemblies not found, using Framework64+WPF
  set REF=%FW64%
  set REF_WPF=%WPF%
  set "PATH=%FW64%;%PATH%"
) else (
  set REF_WPF=%REF%
)
"%FW64%\csc.exe" /nologo /target:exe /out:UiaSniper.exe /reference:%REF_WPF%\UIAutomationClient.dll /reference:%REF_WPF%\UIAutomationTypes.dll /reference:%REF_WPF%\WindowsBase.dll /reference:%REF%\System.Windows.Forms.dll UiaSniper.cs
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
echo Built UiaSniper.exe

REM 部署至 target/release/directshell.exe 供 directShellBridge 使用
if not exist "%~dp0..\..\target\release" mkdir "%~dp0..\..\target\release"
copy /Y UiaSniper.exe "%~dp0..\..\target\release\directshell.exe" >nul
echo Deployed to target/release/directshell.exe
