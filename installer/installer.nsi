; Uptime Access Control T2 - Windows installer (NSIS 3, Unicode, 64-bit).
; Built on Linux by installer/build.sh:
;   makensis -V2 -WX -DVERSION=<versi> -DVERSION_NUM=<a.b.c.d> -DSTAGE=<assembled folder> -DOUTFILE=<exe> installer.nsi
; All logic that can be tested lives in tools\cli.js (render-service, backup, wait, migrate); this script only
; calls it, plus sc.exe, icacls and netsh.

Unicode true
RequestExecutionLevel admin
ManifestDPIAware true
SetCompressor /SOLID lzma

!ifndef VERSION
  !error "Beri -DVERSION=<versi> (dari package.json)"
!endif
!ifndef VERSION_NUM
  !error "Beri -DVERSION_NUM=<a.b.c.d>"
!endif
!ifndef STAGE
  !error "Beri -DSTAGE=<folder hasil assemble.sh win32>"
!endif
!ifndef OUTFILE
  !error "Beri -DOUTFILE=<berkas keluaran>"
!endif

!define APP_NAME "Uptime Access Control T2"
!define SERVICE_ID "UptimeAccessControlT2"
!define REG_APP "Software\UptimeAccessControlT2"
!define REG_UNINSTALL "Software\Microsoft\Windows\CurrentVersion\Uninstall\UptimeAccessControlT2"

Name "${APP_NAME} ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\Uptime Access Control T2"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION_NUM}"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "Pemasang ${APP_NAME}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "MIT"

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

Var PORT
Var ACCESS
Var IsUpgrade
Var OldDir
Var BackedUp
Var DATAROOT
Var DATADIR
Var LOGDIR
Var PortBox
Var RadioLocal
Var RadioSubnet
Var RadioAll

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Buka Uptime Access Control T2 di peramban"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenWebUi

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE}\LICENSES\README.txt"
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfUpgrade
!insertmacro MUI_PAGE_DIRECTORY
Page custom ConfigPageCreate ConfigPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Indonesian"

; Run a command; on failure show a message, set the exit code and stop the installation.
!macro RunOrAbort COMMAND MESSAGE CODE
  nsExec::ExecToLog '${COMMAND}'
  Pop $0
  ${If} $0 != 0
    DetailPrint "GAGAL (kode $0): ${MESSAGE}"
    MessageBox MB_ICONSTOP "${MESSAGE}$\r$\nKode keluar: $0$\r$\nRincian ada di jendela pemasangan." /SD IDOK
    SetErrorLevel ${CODE}
    Abort
  ${EndIf}
!macroend

; Like RunOrAbort, for steps after "install": the half-configured service is removed again before stopping.
!macro RunOrRollback COMMAND MESSAGE CODE
  nsExec::ExecToLog '${COMMAND}'
  Pop $0
  ${If} $0 != 0
    DetailPrint "GAGAL (kode $0): ${MESSAGE}"
    nsExec::ExecToLog '"$INSTDIR\service\UptimeAccessControlT2.exe" uninstall'
    Pop $1
    MessageBox MB_ICONSTOP "${MESSAGE}$\r$\nKode keluar: $0$\r$\nLayanan yang setengah jadi sudah dihapus lagi; data tidak diubah. Jalankan installer sekali lagi setelah masalahnya diperbaiki." /SD IDOK
    SetErrorLevel ${CODE}
    Abort
  ${EndIf}
!macroend

; Stop the service and wait until it is really stopped (a graceful shutdown can take a while).
; In: $R1 = installation folder.  Out: $0 = 0 when stopped.
!macro DefStopService PREFIX
Function ${PREFIX}StopService
  ${If} ${FileExists} "$R1\node\node.exe"
    nsExec::ExecToLog '"$R1\node\node.exe" "$R1\tools\cli.js" stop-service'
    Pop $0
  ${Else}
    nsExec::ExecToLog 'sc.exe stop UptimeAccessControlT2'
    Pop $0
    Sleep 5000
    StrCpy $0 0
  ${EndIf}
FunctionEnd
!macroend

; Remove the service and wait until Windows no longer lists it.  Without the WinSW exe, sc.exe does it.
; In: $R1 = installation folder.  Out: $0 = 0 when gone.
!macro DefRemoveService PREFIX
Function ${PREFIX}RemoveService
  ${If} ${FileExists} "$R1\service\UptimeAccessControlT2.exe"
    nsExec::ExecToLog '"$R1\service\UptimeAccessControlT2.exe" uninstall'
    Pop $0
  ${Else}
    nsExec::ExecToLog 'sc.exe delete UptimeAccessControlT2'
    Pop $0
  ${EndIf}
  ${If} ${FileExists} "$R1\node\node.exe"
    nsExec::ExecToLog '"$R1\node\node.exe" "$R1\tools\cli.js" wait-service-gone --timeout 30'
    Pop $0
  ${Else}
    Sleep 3000
    StrCpy $0 0
  ${EndIf}
FunctionEnd
!macroend

!insertmacro DefStopService ""
!insertmacro DefStopService "un."
!insertmacro DefRemoveService ""
!insertmacro DefRemoveService "un."

; ---------------------------------------------------------------------------------------------------------
; Validation shared by the configuration page and the silent switches.
; In: $PORT, $ACCESS.  Out: $R0 = "" when fine, otherwise the message to show.
Function ValidateConfig
  StrCpy $R0 ""
  IntOp $0 $PORT + 0
  ${If} "$0" != "$PORT"
    StrCpy $R0 "Port harus berupa bilangan bulat antara 1 dan 65535."
    Return
  ${EndIf}
  ${If} $0 < 1
  ${OrIf} $0 > 65535
    StrCpy $R0 "Port harus berupa bilangan bulat antara 1 dan 65535."
    Return
  ${EndIf}
  ${If} $ACCESS != "lokal"
  ${AndIf} $ACCESS != "subnet"
  ${AndIf} $ACCESS != "semua"
    StrCpy $R0 "Akses harus lokal, subnet, atau semua."
  ${EndIf}
FunctionEnd

Function .onInit
  SetRegView 64
  SetShellVarContext all

  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Pemasang ini hanya untuk Windows 64-bit." /SD IDOK
    SetErrorLevel 4
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "Dibutuhkan Windows 10 / Windows Server 2016 atau lebih baru." /SD IDOK
    SetErrorLevel 4
    Abort
  ${EndIf}

  StrCpy $DATAROOT "$APPDATA\UptimeAccessControlT2"
  StrCpy $DATADIR "$DATAROOT\data"
  StrCpy $LOGDIR "$DATAROOT\logs"
  StrCpy $PORT "3001"
  StrCpy $ACCESS "subnet"
  StrCpy $IsUpgrade "0"
  StrCpy $OldDir ""
  StrCpy $BackedUp "0"

  ; an existing installation: keep its folder, port and access as the starting values
  ReadRegStr $0 HKLM "${REG_APP}" "InstallDir"
  ${If} $0 != ""
    StrCpy $IsUpgrade "1"
    StrCpy $OldDir $0
    StrCpy $INSTDIR $0
    ReadRegStr $1 HKLM "${REG_APP}" "Port"
    ${If} $1 != ""
      StrCpy $PORT $1
    ${EndIf}
    ReadRegStr $1 HKLM "${REG_APP}" "Akses"
    ${If} $1 != ""
      StrCpy $ACCESS $1
    ${EndIf}
  ${EndIf}

  ; silent switches /PORT=3001 /AKSES=subnet|lokal|semua
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/PORT=" $1
  ${IfNot} ${Errors}
    StrCpy $PORT $1
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/AKSES=" $1
  ${IfNot} ${Errors}
    StrCpy $ACCESS $1
  ${EndIf}
  ClearErrors

  Call ValidateConfig
  ${If} $R0 != ""
    MessageBox MB_ICONSTOP "$R0" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------------------------------------
; An upgrade always goes into the folder of the existing installation (a /D= switch is ignored then).
Function SkipIfUpgrade
  ${If} $IsUpgrade == "1"
    Abort
  ${EndIf}
FunctionEnd

Function ConfigPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Port untuk halaman web (1 sampai 65535). Bawaan 3001."
  Pop $0
  ${NSD_CreateText} 0 26u 40u 12u "$PORT"
  Pop $PortBox

  ${NSD_CreateGroupBox} 0 48u 100% 74u "Siapa yang boleh membuka halaman web"
  Pop $0
  ${NSD_CreateRadioButton} 8u 62u 92% 12u "Hanya PC ini (tanpa aturan firewall)"
  Pop $RadioLocal
  ${NSD_AddStyle} $RadioLocal ${WS_GROUP}
  ${NSD_CreateRadioButton} 8u 80u 92% 12u "PC di subnet yang sama (disarankan)"
  Pop $RadioSubnet
  ${NSD_CreateRadioButton} 8u 98u 92% 12u "Semua jaringan"
  Pop $RadioAll

  ${If} $ACCESS == "lokal"
    ${NSD_Check} $RadioLocal
  ${ElseIf} $ACCESS == "semua"
    ${NSD_Check} $RadioAll
  ${Else}
    ${NSD_Check} $RadioSubnet
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function ConfigPageLeave
  ${NSD_GetText} $PortBox $PORT
  ${NSD_GetState} $RadioLocal $0
  ${NSD_GetState} $RadioAll $1
  ${If} $0 == ${BST_CHECKED}
    StrCpy $ACCESS "lokal"
  ${ElseIf} $1 == ${BST_CHECKED}
    StrCpy $ACCESS "semua"
  ${Else}
    StrCpy $ACCESS "subnet"
  ${EndIf}

  Call ValidateConfig
  ${If} $R0 != ""
    MessageBox MB_ICONEXCLAMATION "$R0"
    Abort
  ${EndIf}
FunctionEnd

Function OpenWebUi
  ExecShell "open" "http://localhost:$PORT"
FunctionEnd

; ---------------------------------------------------------------------------------------------------------
Section "Uptime Access Control T2" SecMain
  SectionIn RO
  SetShellVarContext all

  ; 1. stop the old service (it stays registered, so nothing is lost if the next steps fail)
  ${If} $OldDir != ""
    DetailPrint "Menghentikan layanan lama ..."
    StrCpy $R1 $OldDir
    Call StopService
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "Layanan lama tidak berhenti. Tidak ada yang diubah. Hentikan dari services.msc lalu jalankan installer lagi." /SD IDOK
      SetErrorLevel 5
      Abort
    ${EndIf}
  ${EndIf}

  ; 2. upgrade: back up the data with the OLD tools before anything is removed; on failure start the old service again
  ${If} $IsUpgrade == "1"
  ${AndIf} ${FileExists} "$OldDir\node\node.exe"
    DetailPrint "Mencadangkan data sebelum upgrade ..."
    nsExec::ExecToLog '"$OldDir\node\node.exe" "$OldDir\tools\cli.js" backup --data "$DATADIR" --label sebelum-upgrade'
    Pop $0
    ${If} $0 != 0
      nsExec::ExecToLog 'sc.exe start UptimeAccessControlT2'
      Pop $0
      MessageBox MB_ICONSTOP "Gagal mencadangkan data. Pemasangan dibatalkan, layanan lama dinyalakan kembali dan tidak ada yang diubah." /SD IDOK
      SetErrorLevel 5
      Abort
    ${EndIf}
    StrCpy $BackedUp "1"
  ${EndIf}

  ; 3. remove the old service
  ${If} $OldDir != ""
    DetailPrint "Menghapus layanan lama ..."
    StrCpy $R1 $OldDir
    Call RemoveService
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "Layanan lama belum hilang dari daftar layanan Windows. Tutup jendela Services / Computer Management lalu jalankan installer lagi." /SD IDOK
      SetErrorLevel 5
      Abort
    ${EndIf}
  ${EndIf}

  ; 4. upgrade into the same folder: replace the program folders completely (data lives elsewhere, never touched here)
  ${If} $IsUpgrade == "1"
  ${AndIf} $INSTDIR == $OldDir
    DetailPrint "Menghapus program versi lama ..."
    RMDir /r "$INSTDIR\app"
    RMDir /r "$INSTDIR\node"
    RMDir /r "$INSTDIR\service"
    RMDir /r "$INSTDIR\tools"
    RMDir /r "$INSTDIR\LICENSES"
  ${EndIf}

  ; 5. program files
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\app"
  File /r "${STAGE}\node"
  File /r "${STAGE}\service"
  File /r "${STAGE}\tools"
  File /r "${STAGE}\LICENSES"

  ; registry, uninstaller and the Add/Remove Programs entry go in early, so a failed start can be uninstalled
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${REG_APP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${REG_APP}" "Port" "$PORT"
  WriteRegStr HKLM "${REG_APP}" "Akses" "$ACCESS"
  WriteRegStr HKLM "${REG_APP}" "Versi" "${VERSION}"
  WriteRegStr HKLM "${REG_UNINSTALL}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKLM "${REG_UNINSTALL}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${REG_UNINSTALL}" "Publisher" "${APP_NAME}"
  WriteRegStr HKLM "${REG_UNINSTALL}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${REG_UNINSTALL}" "DisplayIcon" "$INSTDIR\node\node.exe"
  WriteRegStr HKLM "${REG_UNINSTALL}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${REG_UNINSTALL}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKLM "${REG_UNINSTALL}" "NoModify" 1
  WriteRegDWORD HKLM "${REG_UNINSTALL}" "NoRepair" 1

  ; 6. data and log folders (existing content is never overwritten)
  CreateDirectory "$DATADIR"
  CreateDirectory "$LOGDIR"

  ; The data holds password hashes and secrets: only SYSTEM, Administrators and LocalService (S-1-5-19) get
  ; access, by SID so it works in every language. The children inherit it again after the reset.
  nsExec::ExecToLog 'icacls "$DATAROOT" /setowner *S-1-5-32-544 /T /C /Q'
  Pop $0
  !insertmacro RunOrAbort `icacls "$DATAROOT" /inheritance:r` "Gagal membatasi hak akses folder data." 5
  !insertmacro RunOrAbort `icacls "$DATAROOT" /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-19:(OI)(CI)M` "Gagal mengatur hak akses folder data." 5
  nsExec::ExecToLog 'icacls "$DATADIR" /reset /T /C /Q'
  Pop $0
  nsExec::ExecToLog 'icacls "$LOGDIR" /reset /T /C /Q'
  Pop $0

  ; 7. a copy of the data before this version can migrate it, also when the registry did not say "upgrade"
  ;    (for example after an uninstall that kept the data); nothing happens when there is no data yet
  ${If} $BackedUp != "1"
    DetailPrint "Mencadangkan data yang ada ..."
    !insertmacro RunOrAbort `"$INSTDIR\node\node.exe" "$INSTDIR\tools\cli.js" backup --data "$DATADIR" --label sebelum-upgrade` "Gagal mencadangkan data. Data tidak diubah." 5
  ${EndIf}

  ; 8. the port must be free (an old Kuma may still be running on it)
  DetailPrint "Memeriksa port $PORT ..."
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\tools\cli.js" check-port --port $PORT --access $ACCESS'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Port $PORT sedang dipakai program lain (mungkin Kuma lama yang masih berjalan).$\r$\nHentikan program itu, atau jalankan installer lagi dan pilih port lain." /SD IDOK
    SetErrorLevel 6
    Abort
  ${EndIf}

  ; 9. service configuration and installation
  DetailPrint "Menulis konfigurasi layanan ..."
  !insertmacro RunOrAbort `"$INSTDIR\node\node.exe" "$INSTDIR\tools\cli.js" render-service --template "$INSTDIR\service\service.xml.template" --out "$INSTDIR\service\UptimeAccessControlT2.xml" --install-dir "$INSTDIR" --data-dir "$DATADIR" --log-dir "$LOGDIR" --port $PORT --access $ACCESS` "Gagal menulis konfigurasi layanan." 5
  DetailPrint "Memasang layanan Windows ..."
  !insertmacro RunOrAbort `"$INSTDIR\service\UptimeAccessControlT2.exe" install` "Gagal memasang layanan Windows." 5
  !insertmacro RunOrRollback `sc.exe config UptimeAccessControlT2 start= delayed-auto obj= "NT AUTHORITY\LocalService" password= ""` "Gagal mengatur akun dan mode mulai layanan." 5

  ; 10. firewall: a fresh rule every time, none when only this PC may connect
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Uptime Access Control T2"'
  Pop $0
  ${If} $ACCESS == "subnet"
    !insertmacro RunOrRollback `netsh advfirewall firewall add rule name="Uptime Access Control T2" dir=in action=allow protocol=TCP localport=$PORT program="$INSTDIR\node\node.exe" profile=any remoteip=LocalSubnet` "Gagal membuat aturan firewall." 5
  ${ElseIf} $ACCESS == "semua"
    !insertmacro RunOrRollback `netsh advfirewall firewall add rule name="Uptime Access Control T2" dir=in action=allow protocol=TCP localport=$PORT program="$INSTDIR\node\node.exe" profile=any remoteip=Any` "Gagal membuat aturan firewall." 5
  ${EndIf}

  ; 11. start and wait for the web page
  DetailPrint "Menyalakan layanan ..."
  !insertmacro RunOrAbort `"$INSTDIR\service\UptimeAccessControlT2.exe" start` "Layanan gagal dinyalakan. Lihat log di $LOGDIR" 5
  DetailPrint "Menunggu halaman web menjawab (maksimal 60 detik) ..."
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\tools\cli.js" wait --url http://127.0.0.1:$PORT/ --timeout 60'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Layanan belum menjawab. Lihat log di $LOGDIR"
    MessageBox MB_ICONEXCLAMATION "Layanan sudah dipasang tetapi belum menjawab di port $PORT dalam 60 detik.$\r$\nLihat log di:$\r$\n$LOGDIR" /SD IDOK
    SetErrorLevel 3
  ${EndIf}

  ; 12. Start Menu
  CreateDirectory "$SMPROGRAMS\Uptime Access Control T2"
  WriteINIStr "$SMPROGRAMS\Uptime Access Control T2\Buka Uptime Access Control T2.url" "InternetShortcut" "URL" "http://localhost:$PORT"
  CreateShortCut "$SMPROGRAMS\Uptime Access Control T2\Pindahkan data lama.lnk" "$INSTDIR\tools\Pindahkan-Data.cmd"
  CreateShortCut "$SMPROGRAMS\Uptime Access Control T2\Hapus Uptime Access Control T2.lnk" "$INSTDIR\uninstall.exe"
SectionEnd

; ---------------------------------------------------------------------------------------------------------
Function un.onInit
  SetRegView 64
  SetShellVarContext all
  StrCpy $DATAROOT "$APPDATA\UptimeAccessControlT2"
  StrCpy $DATADIR "$DATAROOT\data"
  StrCpy $LOGDIR "$DATAROOT\logs"
FunctionEnd

Section "Uninstall"
  SetShellVarContext all

  ; service and firewall rule first
  StrCpy $R1 $INSTDIR
  DetailPrint "Menghentikan dan menghapus layanan ..."
  Call un.StopService
  Call un.RemoveService
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Uptime Access Control T2"'
  Pop $0

  ; program, shortcuts, registry
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\service"
  RMDir /r "$INSTDIR\tools"
  RMDir /r "$INSTDIR\LICENSES"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  RMDir /r "$SMPROGRAMS\Uptime Access Control T2"
  DeleteRegKey HKLM "${REG_APP}"
  DeleteRegKey HKLM "${REG_UNINSTALL}"

  ; the data is only removed after an explicit Yes; a silent uninstall always keeps it
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Hapus juga data (database, log, dan cadangan) di $DATAROOT ?" /SD IDNO IDYES removeData IDNO keepData
removeData:
  IfSilent keepData
  RMDir /r "$DATADIR"
  RMDir /r "$LOGDIR"
  RMDir "$DATAROOT"
keepData:
SectionEnd
