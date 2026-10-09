const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const NSI_FILE = path.join(__dirname, "..", "..", "installer", "installer.nsi");
const BUILD_FILE = path.join(__dirname, "..", "..", "installer", "build.sh");

/**
 * Read a file with Windows line endings folded to \n.
 * @param {string} file The file
 * @returns {string} The text
 */
function read(file) {
    return fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
}

/**
 * Cut the text of a Section / Function / SectionEnd block by its opening line.
 * @param {string} text The whole script
 * @param {RegExp} start Matches the opening line
 * @param {RegExp} end Matches the closing line
 * @returns {string} The block, or "" when not found
 */
function block(text, start, end) {
    const from = text.search(start);
    if (from < 0) {
        return "";
    }
    const rest = text.slice(from);
    const to = rest.search(end);
    return to < 0 ? rest : rest.slice(0, to);
}

describe("installer.nsi (text checks, the script itself can only run on Windows)", () => {
    const nsi = read(NSI_FILE);

    test("requests administrator and 64-bit registry", () => {
        assert.match(nsi, /^Unicode true$/m);
        assert.match(nsi, /^RequestExecutionLevel admin$/m);
        assert.match(nsi, /^\s*SetRegView 64$/m);
        assert.match(nsi, /\$\{RunningX64\}/);
        assert.match(nsi, /InstallDir "\$PROGRAMFILES64\\Uptime Access Control T2"/);
        assert.match(nsi, /MUI_LANGUAGE "Indonesian"/);
    });

    test("uses the pinned version define", () => {
        assert.match(nsi, /!ifndef VERSION\s+!error[^\n]*VERSION/);
        assert.match(nsi, /VIProductVersion "\$\{VERSION_NUM\}"/);
        assert.match(nsi, /OutFile "\$\{OUTFILE\}"/);
        assert.doesNotMatch(nsi, /3\.0\.0-beta/, "the version is not hard-coded in the script");
    });

    test("compresses solid lzma", () => {
        assert.match(nsi, /^SetCompressor \/SOLID lzma$/m);
    });

    test("removes the old program folders only on an upgrade into the same folder", () => {
        const section = block(nsi, /^Section "Uptime Access Control T2"/m, /^SectionEnd/m);
        assert.match(
            section,
            /\$\{If\} \$IsUpgrade == "1"\s+\$\{AndIf\} \$INSTDIR == \$OldDir[\s\S]*?RMDir \/r "\$INSTDIR\\app"/,
            "guarded by $IsUpgrade and by $INSTDIR == $OldDir"
        );
        for (const folder of ["app", "node", "service", "tools", "LICENSES"]) {
            assert.ok(section.includes(`RMDir /r "$INSTDIR\\${folder}"`), folder);
        }
        assert.doesNotMatch(section, /RMDir \/r "\$INSTDIR"/, "never removes the chosen folder itself");
        assert.doesNotMatch(section, /RMDir \/r "\$DATA/, "installing never removes data");
    });

    test("skips the folder page on an upgrade, so the folder cannot differ from the registered one", () => {
        assert.match(nsi, /!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfUpgrade\s+!insertmacro MUI_PAGE_DIRECTORY/);
        const skip = block(nsi, /^Function SkipIfUpgrade/m, /^FunctionEnd/m);
        assert.match(skip, /\$IsUpgrade == "1"/);
        assert.match(skip, /Abort/);
    });

    test("stops the old service, backs up and only then removes anything", () => {
        const section = block(nsi, /^Section "Uptime Access Control T2"/m, /^SectionEnd/m);
        const order = [
            section.indexOf("Call StopService"),
            section.indexOf("backup --data"),
            section.indexOf("Call RemoveService"),
            section.indexOf('RMDir /r "$INSTDIR\\app"'),
            section.indexOf("File /r"),
        ];
        assert.ok(
            order.every((n) => n > 0),
            JSON.stringify(order)
        );
        assert.deepEqual(
            order,
            [...order].sort((a, b) => a - b),
            "stop, backup (old tools), remove service, delete, extract"
        );
        assert.match(section, /--label sebelum-upgrade/);
    });

    test("restarts the old service when the backup before an upgrade fails", () => {
        const section = block(nsi, /^Section "Uptime Access Control T2"/m, /^SectionEnd/m);
        const firstBackup = section.indexOf("backup --data");
        const removal = section.indexOf("Call RemoveService");
        const between = section.slice(firstBackup, removal);
        assert.match(between, /sc\.exe start UptimeAccessControlT2/);
        assert.match(between, /SetErrorLevel 5/);
    });

    test("backs up the data on every install, not only when the registry says upgrade", () => {
        const section = block(nsi, /^Section "Uptime Access Control T2"/m, /^SectionEnd/m);
        const extracted = section.indexOf('File /r "${STAGE}\\LICENSES"');
        const later = section.indexOf("backup --data", extracted);
        assert.ok(later > extracted, "a second backup runs with the new tools after extraction");
        const guard = section.slice(extracted, later);
        assert.match(guard, /\$BackedUp/);
        assert.doesNotMatch(
            guard,
            /\$IsUpgrade/,
            "not tied to the upgrade flag (uninstall keeping data, then install)"
        );
    });

    test("checks the port after extraction and before the service is installed", () => {
        const section = block(nsi, /^Section "Uptime Access Control T2"/m, /^SectionEnd/m);
        const extracted = section.indexOf('File /r "${STAGE}\\LICENSES"');
        const check = section.indexOf("check-port --port $PORT --access $ACCESS");
        const render = section.indexOf("render-service");
        assert.ok(check > extracted && render > check, "extract, check-port, render-service");
        assert.match(section.slice(check, render), /SetErrorLevel 6|, 6|\s6\b/);
    });

    test("removes a half-configured service when a later step fails", () => {
        const rollback = block(nsi, /^!macro RunOrRollback/m, /^!macroend/m);
        assert.match(rollback, /UptimeAccessControlT2\.exe" uninstall/);
        assert.match(rollback, /Abort/);
        const section = block(nsi, /^Section "Uptime Access Control T2"/m, /^SectionEnd/m);
        const sc = section.indexOf("sc.exe config UptimeAccessControlT2");
        assert.match(section.slice(section.lastIndexOf("!insertmacro", sc), sc), /RunOrRollback/);
        assert.match(section, /RunOrRollback `netsh advfirewall firewall add rule/);
    });

    test("falls back to sc.exe when the old service exe is gone", () => {
        const fn = block(nsi, /^!macro DefRemoveService/m, /^!macroend/m);
        assert.match(fn, /sc\.exe delete UptimeAccessControlT2/);
        assert.match(fn, /wait-service-gone/);
    });

    test("sets the service account and start mode with sc.exe config", () => {
        assert.match(
            nsi,
            /sc\.exe config UptimeAccessControlT2 start= delayed-auto obj= "NT AUTHORITY\\LocalService" password= ""/
        );
        const config = nsi.indexOf("sc.exe config UptimeAccessControlT2");
        const install = nsi.indexOf('UptimeAccessControlT2.exe" install');
        assert.ok(install > 0 && config > install, "config comes after install");
    });

    test("restricts the data root to SYSTEM, Administrators and LocalService by SID", () => {
        assert.match(nsi, /icacls "\$DATAROOT" \/setowner \*S-1-5-32-544/);
        assert.match(nsi, /icacls "\$DATAROOT" \/inheritance:r/);
        assert.match(
            nsi,
            /icacls "\$DATAROOT" \/grant:r \*S-1-5-18:\(OI\)\(CI\)F \*S-1-5-32-544:\(OI\)\(CI\)F \*S-1-5-19:\(OI\)\(CI\)M/
        );
        assert.match(nsi, /icacls "\$DATADIR" \/reset \/T/);
        assert.match(nsi, /icacls "\$LOGDIR" \/reset \/T/);
        assert.doesNotMatch(nsi, /BUILTIN\\Users|\*S-1-5-32-545/, "ordinary users get nothing");
    });

    test("adds the firewall rule by access mode and deletes it first", () => {
        assert.match(nsi, /netsh advfirewall firewall delete rule name="Uptime Access Control T2"/);
        assert.match(nsi, /remoteip=LocalSubnet/);
        assert.match(nsi, /remoteip=Any/);
        assert.match(nsi, /program="\$INSTDIR\\node\\node\.exe"/);
        assert.match(nsi, /profile=any/);
        assert.match(nsi, /localport=\$PORT/);
    });

    test("deletes the firewall rule and the service on uninstall, before any file", () => {
        const section = block(nsi, /^Section "Uninstall"/m, /^SectionEnd/m);
        assert.match(section, /netsh advfirewall firewall delete rule name="Uptime Access Control T2"/);
        const stop = section.indexOf("Call un.StopService");
        const remove = section.indexOf("Call un.RemoveService");
        const files = section.indexOf('RMDir /r "$INSTDIR\\app"');
        assert.ok(stop > 0 && remove > stop && files > remove, "stop, remove service, then delete files");
        assert.match(nsi, /stop-service/);
        assert.match(nsi, /UptimeAccessControlT2\.exe" uninstall/);
    });

    test("never removes the data folder before the question", () => {
        const section = block(nsi, /^Section "Uninstall"/m, /^SectionEnd/m);
        const question = section.indexOf("MessageBox");
        const removal = section.indexOf('RMDir /r "$DATADIR"');
        assert.ok(question > 0, "the uninstaller asks");
        assert.ok(removal > question, "removal comes after the question");
        assert.match(section, /MB_DEFBUTTON2/, "the default answer is No");
        assert.match(section, /\/SD IDNO/, "silent uninstall answers No");
        const between = section.slice(question, removal);
        assert.match(between, /IfSilent/, "silent mode skips the removal");
        assert.match(between, /IDYES|StrCmp \$0 IDYES/);
    });

    test("exits non-zero in silent mode when the service does not answer", () => {
        const section = block(nsi, /^Section "Uptime Access Control T2"/m, /^SectionEnd/m);
        const wait = section.indexOf('cli.js" wait');
        assert.ok(wait > 0);
        assert.match(section.slice(wait), /SetErrorLevel 3/);
        assert.match(section, /--timeout 60/);
    });

    test("rejects 32-bit Windows and invalid silent arguments with their own exit codes", () => {
        const init = block(nsi, /^Function \.onInit/m, /^FunctionEnd/m);
        assert.match(init, /SetErrorLevel 4/);
        assert.match(init, /SetErrorLevel 2/);
        assert.match(init, /\/PORT=/);
        assert.match(init, /\/AKSES=/);
        assert.match(nsi, /lokal/);
        assert.match(nsi, /subnet/);
        assert.match(nsi, /semua/);
    });

    test("validates the port as a whole number between 1 and 65535", () => {
        const check = block(nsi, /^Function ValidateConfig/m, /^FunctionEnd/m);
        assert.ok(check.length > 0, "a shared validation function exists");
        assert.match(check, /65535/);
        assert.match(check, /IntOp/);
    });

    test("writes registry values, the uninstaller and Start Menu shortcuts", () => {
        assert.match(nsi, /!define REG_APP "Software\\UptimeAccessControlT2"/);
        for (const name of ["InstallDir", "Port", "Akses", "Versi"]) {
            assert.match(nsi, new RegExp(`WriteRegStr HKLM "\\$\\{REG_APP\\}" "${name}"`), name);
        }
        assert.match(
            nsi,
            /!define REG_UNINSTALL "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\UptimeAccessControlT2"/
        );
        assert.match(nsi, /WriteUninstaller/);
        assert.match(nsi, /Buka Uptime Access Control T2/);
        assert.match(nsi, /Pindahkan data lama/);
    });
});

describe("build.sh", () => {
    const build = read(BUILD_FILE);

    test("stops at the first error and builds with warnings as errors", () => {
        assert.match(build, /set -euo pipefail/);
        assert.match(build, /makensis -V2 -WX/);
        assert.match(build, /assemble\.sh" win32/);
        assert.match(build, /sha256sum/);
        assert.match(build, /BUILD-INFO\.txt/);
    });
});
