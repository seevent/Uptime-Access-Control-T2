# Paket instalasi Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membangun `UptimeAccessControlT2-Setup-3.0.0-beta.0.exe`, installer NSIS yang memasang aplikasi sebagai layanan Windows, beserta skrip pindah data, dari Linux.

**Architecture:** Semua logika yang bisa diuji dipindahkan ke tiga modul Node di `installer/payload/tools/` (`data.js`, `service.js`, `cli.js`) yang diuji dengan `node:test` di sini; skrip NSIS hanya memanggil `node.exe tools\cli.js ...`, `sc.exe`, `netsh`, dan `icacls`. Folder program dirakit oleh skrip shell dari daftar berkas tetap dan `npm ci --omit=dev`, lalu diperiksa oleh `check-payload.js` sebelum dikompilasi.

**Tech Stack:** Node 26 (CommonJS untuk `installer/`), `better-sqlite3` (API backup), NSIS 3 (`makensis`), WinSW 2.x, Playwright (Python) untuk asap Linux.

**Spec:** `docs/superpowers/specs/2026-10-08-windows-installer-design.md`

## Global Constraints

- Tidak ada perubahan pada kode aplikasi (`server/`, `src/`, `db/`); semuanya di `installer/` dan `test/backend-test/`. Sandbox tidak punya git: langkah "commit" diganti baris ledger `/home/claude/ledger/progress.md` (awali dengan `Feature8 Task N:`).
- Perintah uji satu berkas: `export PATH=/tmp/nodeinst/node_modules/node/bin:$PATH; TEST_BACKEND=1 node --import=tsx --test test/backend-test/<berkas>`; seluruh suite: `npm run test-backend` (sekarang 243/243, tidak boleh turun).
- Lint: `node_modules/.bin/eslint --ext .js,.vue installer test` dan `node_modules/.bin/prettier --check installer test`.
- Nama layanan `UptimeAccessControlT2`, nama tampil "Uptime Access Control T2"; program `C:\Program Files\Uptime Access Control T2\` (`node\`, `app\`, `service\`, `tools\`, `LICENSES\`); data `C:\ProgramData\UptimeAccessControlT2\data`, log `...\logs`, cadangan `...\data\backup`.
- Node 26.10.0 win-x64; port bawaan 3001; akses `lokal` (`UPTIME_KUMA_HOST=127.0.0.1`, tanpa aturan firewall), `subnet` (bawaan, `remoteip=LocalSubnet`), `semua` (`Any`); aturan firewall bernama "Uptime Access Control T2", semua profil, terikat pada `node.exe`.
- Lingkungan layanan: `NODE_ENV=production`, `DATA_DIR`, `UPTIME_KUMA_PORT`, `UPTIME_KUMA_DB_TYPE=sqlite`. Perintah: `node\node.exe --import=tsx server/server.js`, direktori kerja `app\`.
- Akun `NT AUTHORITY\LocalService` dan mode `delayed-auto` diatur dengan `sc.exe config` setelah `install`; restart 10 dtk tiga kali lalu 60 dtk, reset 1 jam; batas berhenti 20 dtk; log 10 MB, simpan 8.
- Jendela WAL basi 15 detik; label cadangan `sebelum-upgrade` dan `sebelum-pindah`; format stempel `YYYYMMDD-HHMMSS` (waktu lokal).
- Mode senyap: `/S /PORT=3001 /AKSES=subnet|lokal|semua`; kode keluar bukan nol bila layanan tidak menjawab dalam 60 dtk. Installer meminta administrator dan hanya 64-bit; bahasa Indonesia.
- Unduhan hanya dari nodejs.org, rilis GitHub WinSW, rilis GitHub `WiseLibs/better-sqlite3`, registri npm, dan apt (`nsis`, `p7zip-full`); semua dikunci di `installer/versions.json` dengan SHA-256. Bila tidak cocok, berhenti dan laporkan.
- Pesan untuk pengguna berbahasa Indonesia. `AGENTS.md` upstream tidak berlaku (fork pribadi, tanpa PR).

## Review Focus

- Baris yang baru ada di `kuma.db-wal` (belum di-checkpoint) tetap ikut tersalin: diuji di Task 1.
- Jalur dengan spasi, `&`, `'`, dan huruf non-ASCII (mis. `C:\Users\Yuli Syarif\Downloads\Monitoring Network\data`) benar di XML layanan dan argumen CLI: Task 2.
- Pindah data dijalankan dua kali berturut-turut tidak galat dan membuat dua cadangan berbeda: Task 1.
- Database sumber kosong atau tanpa tabel `heartbeat`/`network_device` (versi lama): ringkasan 0, bukan galat: Task 1.
- Port tidak valid (kosong, `abc`, `0`, `65536`, `3001.5`) ditolak sebelum menulis XML: Task 2.

---

### Task 1: Cadangan dan pindah data (`data.js`)

**Files:**
- Create: `installer/payload/tools/data.js`
- Test: `test/backend-test/test-installer-data.js`

**Interfaces:**
- Produces: `backupData({ dataDir: string, label: string, now?: () => Date }) -> Promise<{ backupDir: string | null }>` (`null` bila tidak ada yang dicadangkan; menyalin `kuma.db` lewat API backup SQLite, `db-config.json`, dan `upload/` ke `<dataDir>/backup/<label>-<stempel>/`, tidak menyalin folder `backup`).
- Produces: `migrate({ source, dest, service: { stop(): Promise<void>, start(): Promise<void> }, force?: boolean, now?: () => Date, log?: (msg: string) => void, hooks?: { afterCopy?: () => Promise<void> } }) -> Promise<{ backupDir: string | null, counts: { monitor: number, heartbeat: number, network_device: number, network_category: number } }>`.
- Galat (pesan persis): `kuma.db tidak ditemukan di <source>`; `Folder sumber dan tujuan sama`; `Kuma lama sepertinya masih berjalan (kuma.db-wal baru berubah). Hentikan dulu, atau gunakan --force`; `Hasil salinan tidak cocok dengan sumber`.
- `better-sqlite3` dimuat dengan `require("better-sqlite3")`, cadangan `require(path.join(__dirname, "..", "app", "node_modules", "better-sqlite3"))` (tata letak terpasang).

- [ ] **Step 1: Tulis tes (semua gagal)** di `test-installer-data.js`, memakai folder sementara (`fs.mkdtempSync`) dan `better-sqlite3` untuk membuat sumber WAL (`journal_mode=WAL`, koneksi dibiarkan terbuka agar baris ada di `-wal`; umur berkas `-wal` dibuat tua dengan `fs.utimesSync` atau `now` digeser 60 dtk). Nama tes dan asersi:
  - `backupData names the folder label-stamp and keeps kuma.db, db-config.json and upload` — `now = () => new Date(2026, 9, 8, 13, 5, 9)` → `backupDir` berakhir `sebelum-upgrade-20261008-130509`; berisi ketiganya; basis data cadangan bisa dibuka dan jumlah barisnya sama.
  - `backupData returns null when the data folder has nothing to save`.
  - `migrate copies rows that only exist in the -wal file` (Review Focus 1).
  - `migrate copies db-config.json with its authSecret, upload and screenshots`.
  - `migrate returns the counts` — mis. 3 monitor, 5 heartbeat, 2 perangkat, 2 kategori.
  - `migrate works on a database without heartbeat and network tables` — counts 0 (Review Focus 4).
  - `migrate refuses the same folder, also spelled with a trailing /.`.
  - `migrate refuses a source without kuma.db`.
  - `migrate refuses a fresh -wal unless force is set`.
  - `migrate backs up the existing destination before replacing it` — cadangan memuat `kuma.db` lama.
  - `migrate twice in a row works and leaves two different backup folders` (Review Focus 3; `now` berbeda 1 detik).
  - `migrate stops the service first and starts it last, also when it fails` — urutan `["stop", ..., "start"]` pada tiruan layanan; kegagalan disuntik lewat `hooks.afterCopy`.
  - `migrate puts the old destination back when the copy fails halfway` — `kuma.db` dan `db-config.json` tujuan kembali seperti semula.
  - `migrate refuses a copy whose integrity_check or counts differ` (sisipkan baris ke salinan lewat `hooks.afterCopy`, harapkan `Hasil salinan tidak cocok dengan sumber`).
- [ ] **Step 2: Jalankan; harapkan GAGAL** (`Cannot find module '.../data.js'`).
- [ ] **Step 3: Implementasi `data.js`** sesuai Interfaces. Urutan `migrate`: validasi → stop layanan → `backupData(label "sebelum-pindah")` → `db.backup()` ke `kuma.db.new` di folder tujuan → hapus `kuma.db-wal`/`-shm` tujuan → ganti nama jadi `kuma.db` → salin `db-config.json`, `upload`, `screenshots` (`fs.cpSync` rekursif) → `hooks.afterCopy` → verifikasi (`PRAGMA integrity_check` = `ok`, jumlah `monitor` dan `heartbeat` sama dengan sumber) → `finally` pulihkan dari cadangan bila gagal, lalu selalu `service.start()`. Hitung jumlah dengan `SELECT COUNT(*)`, tabel yang tidak ada dihitung 0.
- [ ] **Step 4: Jalankan tes; harapkan semua LULUS.**
- [ ] **Step 5: Lint dan ledger** (`eslint`, `prettier --write`, lalu baris ledger Task 1).

### Task 2: Layanan, tunggu HTTP, dan CLI (`service.js`, `cli.js`, `Pindahkan-Data.cmd`)

**Files:**
- Create: `installer/payload/tools/service.js`, `installer/payload/tools/cli.js`, `installer/payload/tools/Pindahkan-Data.cmd`, `installer/service.xml.template`
- Test: `test/backend-test/test-installer-service.js`

**Interfaces:**
- Consumes: `backupData`, `migrate` dari Task 1.
- Produces: `renderServiceXml({ template, installDir, dataDir, logDir, port, access }) -> string` (token `@INSTALL_DIR@`, `@DATA_DIR@`, `@LOG_DIR@`, `@PORT@`, `@HOST_ENV@`; nilai di-escape XML; galat `Port tidak valid` / `Akses tidak valid`).
- Produces: `makeServiceControl({ name, exec: (cmd, args) => Promise<{ code: number, stdout: string }>, sleep?, timeoutMs? }) -> { state(): Promise<"RUNNING"|"STOPPED"|"MISSING"|string>, stop(): Promise<void>, start(): Promise<void> }` (memakai `sc.exe query/stop/start`; kode 1060 = MISSING).
- Produces: `waitForHttp({ url, timeoutMs?, intervalMs?, fetchFn?, sleep? }) -> Promise<boolean>` (benar bila ada jawaban HTTP apa pun).
- Produces: `parseArgs(argv: string[]) -> { _: string[], flags: Record<string, string | true> }` dan `main(argv, deps?) -> Promise<number>` di `cli.js` dengan subperintah `render-service`, `wait`, `backup`, `migrate` (opsi: `--template --out --install-dir --data-dir --log-dir --port --access`; `--url --timeout`; `--data --label`; `--source --data --yes --force`). Tanpa `--source`, `migrate` bertanya lewat `readline` (disuntikkan sebagai `deps.ask`). Kode keluar 0/1; pesan Indonesia; bila `UAC_FAKE_SERVICE=1` (khusus uji) kontrol layanan diganti tiruan yang tidak melakukan apa-apa; `--data` bawaan `process.env.DATA_DIR` atau `C:\ProgramData\UptimeAccessControlT2\data`.

- [ ] **Step 1: Tulis tes (gagal)**:
  - `renderServiceXml fills every token and leaves none behind` — keluaran tanpa `@[A-Z_]+@`; memuat `<id>UptimeAccessControlT2</id>`, `UPTIME_KUMA_DB_TYPE`=`sqlite`, `NODE_ENV`=`production`, `--import=tsx server/server.js`, `<stoptimeout>20 sec</stoptimeout>`, tiga `<onfailure action="restart" delay="10 sec"/>` lalu satu `delay="60 sec"`.
  - `renderServiceXml adds UPTIME_KUMA_HOST only for access lokal` — `lokal` memuat `127.0.0.1`; `subnet` dan `semua` tidak memuat `UPTIME_KUMA_HOST`.
  - `renderServiceXml escapes paths with spaces, ampersand, quote and non-ASCII` — `C:\Users\Yuli Syarif\Downloads\Monitoring Network & Co\data'é"` menjadi `&amp;`, `&apos;`, `&quot;` dan huruf `é` utuh (Review Focus 2).
  - `renderServiceXml rejects bad ports` — `""`, `"abc"`, `0`, `65536`, `3001.5`, `-1` → `Port tidak valid`; `"3001"` dan `65535` diterima. Akses `"x"` → `Akses tidak valid`.
  - `service control stop waits for STOPPED, does nothing when already stopped or missing, and times out`; `start throws Layanan UptimeAccessControlT2 belum terpasang when missing`.
  - `waitForHttp is true after a few refused tries, false after the timeout` (fetch tiruan dan `sleep` tiruan, tanpa menunggu nyata).
  - `parseArgs handles --key value, --flag and positionals`; `main wait returns 1 on timeout and 0 on answer`; `main render-service writes the file`; `main migrate with --source --yes calls migrate with the service control`; `main migrate asks for the source when it is missing`; `main migrate uses a no-op service when UAC_FAKE_SERVICE=1`; `main with an unknown command prints usage and returns 1`.
- [ ] **Step 2: Jalankan; harapkan GAGAL.**
- [ ] **Step 3: Implementasi `service.js` dan `cli.js`**, tulis `service.xml.template` (WinSW 2.x: `<id>`, `<name>`, `<description>`, `<executable>@INSTALL_DIR@\node\node.exe</executable>`, `<arguments>`, `<workingdirectory>@INSTALL_DIR@\app</workingdirectory>`, `<env>` untuk lingkungan di Global Constraints, `<onfailure>`, `<resetfailure>1 hour</resetfailure>`, `<stoptimeout>`, `<logpath>@LOG_DIR@</logpath>`, `<log mode="roll-by-size">` 10240 KB / 8 berkas). Sintaks elemen WinSW dicocokkan dengan README rilis WinSW yang dikunci di Task 4 (catat penyesuaian sebagai ruling). Tulis `Pindahkan-Data.cmd`: naikkan hak lewat `powershell -Command Start-Process -Verb RunAs` bila belum admin, lalu `"%~dp0..\node\node.exe" "%~dp0cli.js" migrate %*` dan `pause`.
- [ ] **Step 4: Jalankan tes; harapkan semua LULUS.**
- [ ] **Step 5: Lint dan ledger.**

### Task 3: Pemeriksa isi paket (`check-payload.js`)

**Files:**
- Create: `installer/lib/check-payload.js`, `installer/app-files.txt`
- Test: `test/backend-test/test-installer-payload.js`

**Interfaces:**
- Produces: `checkPayload({ dir: string, platform: "win32" | "linux" }) -> { ok: boolean, problems: string[] }`; `isPeX64(file) -> boolean` (tanda `MZ`, tanda `PE\0\0`, mesin `0x8664`); `isElf(file) -> boolean`.
- Memeriksa (relatif ke `dir`): ada `app/server/server.js`, `app/dist/index.html`, `app/src/util.ts`, `app/package.json`, `app/node_modules/tsx`, `app/node_modules/better-sqlite3/build/Release/better_sqlite3.node` (PE x64 untuk `win32`, ELF untuk `linux`), `@esbuild/win32-x64` untuk `win32` (`@esbuild/linux-x64` untuk `linux`); `node/node.exe` hanya untuk `win32`; tidak ada `app/test`, `app/docs`, `app/data`; tidak ada paket terlarang `vite`, `vue`, `eslint`, `@playwright/test` di `app/node_modules`; tidak ada `.node` milik OS lain (pengecualian: berkas `oracledb` yang dipertahankan: `oracledb-*-win32-x64.node` untuk `win32`). Tiap masalah satu kalimat Indonesia berawalan jalur.
- `app-files.txt`: satu jalur per baris relatif ke akar proyek: `server`, `src`, `db`, `dist`, `extra`, `package.json`, `package-lock.json`, `LICENSE`.

- [ ] **Step 1: Tulis tes (gagal)** yang membangun folder sintetis (berkas kecil dengan header PE/ELF palsu) untuk dua platform: `a complete win32 layout is ok`, `a complete linux layout is ok`, dan satu tes per masalah: `reports a Linux better_sqlite3.node in the win32 payload`, `reports a missing @esbuild/win32-x64`, `reports vite left in node_modules`, `reports a stray test folder`, `reports a missing node.exe`, `reports a foreign .node file`; `isPeX64 rejects a 32-bit PE and a text file`.
- [ ] **Step 2: Jalankan; harapkan GAGAL.**
- [ ] **Step 3: Implementasi `check-payload.js`** dan tulis `app-files.txt`.
- [ ] **Step 4: Jalankan tes; harapkan LULUS.**
- [ ] **Step 5: Lint dan ledger.**

### Task 4: Komponen terkunci dan perakitan (`versions.json`, `fetch.sh`, `assemble.sh`)

**Files:**
- Create: `installer/versions.json`, `installer/lib/fetch.sh`, `installer/lib/assemble.sh`

**Interfaces:**
- Consumes: `checkPayload` (Task 3) lewat `node -e`.
- Produces: `fetch.sh` — fungsi `fetch_verified <url> <sha256> <berkas>` (unduh, hitung `sha256sum`, hapus dan gagal bila berbeda); `assemble.sh <win32|linux> <folder-keluaran>` — merakit `app/` dari `app-files.txt`, memasang dependensi produksi, dan (untuk `win32`) meletakkan `node/`, `service/UptimeAccessControlT2.exe`, binary `better_sqlite3.node` Windows, `tools/` dan `LICENSES/`; mengakhiri dengan `checkPayload` dan gagal bila `ok` salah.
- `versions.json`: `{ "node": {"version","url","sha256"}, "winsw": {"version","url","sha256"}, "betterSqlite3": {"version","target","sha256"} }`.

- [ ] **Step 1: Periksa asal komponen** (skill `supermatt:dependency-vetting`): Node 26.10.0 win-x64 zip (cocokkan dengan `SHASUMS256.txt` nodejs.org), WinSW (rilis resmi `winsw/winsw`; ambil `digest` aset lewat `gh api`), prebuild `better-sqlite3` 12.11.1 Node 26.10.0 win32-x64 (aset rilis `WiseLibs/better-sqlite3`, hash dari `gh api`). Tulis nilai ke `versions.json`. Catat versi WinSW dan bagian sintaks XML yang perlu disesuaikan (Task 2). Bila ada yang tidak bisa diverifikasi: berhenti dan laporkan.
- [ ] **Step 2: Tulis `fetch.sh`; uji dengan hash yang salah** — `fetch_verified` pada berkas kecil dengan hash salah harus keluar bukan nol dan menghapus berkas; dengan hash benar keluar 0.
- [ ] **Step 3: Tulis `assemble.sh`.** Untuk `linux`: `npm ci --omit=dev` di folder rakitan. Untuk `win32`: `npm ci --omit=dev --ignore-scripts --os=win32 --cpu=x64`, lalu letakkan `better_sqlite3.node` hasil `prebuild-install --platform win32 --arch x64 --runtime node --target 26.10.0` (atau ekstrak aset terverifikasi) ke `build/Release`, dan pangkas berkas `.node` `oracledb` selain win32-x64.
- [ ] **Step 4: Jalankan `assemble.sh linux /tmp/stage-linux` dan `assemble.sh win32 /tmp/stage-win`**; keduanya harus berakhir `ok` dari `checkPayload`. Catat ukuran masing-masing di ledger.
- [ ] **Step 5: Ledger.**

### Task 5: Asap paket produksi di Linux

**Files:**
- Create: `installer/smoke/run-linux.sh`, `installer/smoke/browse.py`

**Interfaces:**
- Consumes: folder rakitan Linux dari Task 4.
- Produces: `run-linux.sh <folder-rakitan>` — jalankan server dari folder itu dengan `DATA_DIR` sementara, `UPTIME_KUMA_PORT=3115`, `UPTIME_KUMA_DB_TYPE=sqlite`, `NODE_ENV=production`; tunggu `cli.js wait`; panggil `browse.py`; matikan server; keluar 0 hanya bila semuanya lulus.

- [ ] **Step 1: Tulis `browse.py`** (Playwright, Chromium bawaan): buka `/`, buat admin dengan kredensial uji acak (tidak dicetak), masuk, buka `/network-scan`, jalankan scan `127.0.0.1`, harapkan baris `127.0.0.1`, dan tidak ada galat konsol.
- [ ] **Step 2: Tulis `run-linux.sh`** dan jalankan terhadap `/tmp/stage-linux`. Harapkan: log server tanpa `MODULE_NOT_FOUND`, `cli.js wait` keluar 0, `browse.py` mencetak `SMOKE OK`.
- [ ] **Step 3: Bukti hijau:** jalankan sekali lagi dengan `DATA_DIR` berisi salinan `kuma.db` yang dipindahkan oleh `cli.js migrate --source <data uji> --yes` (layanan tiruan lewat `UAC_FAKE_SERVICE=1`) dan periksa monitor lama tampil di halaman.
- [ ] **Step 4: Ledger.**

### Task 6: Installer NSIS dan orkestrasi build

**Files:**
- Create: `installer/installer.nsi`, `installer/build.sh`
- Test: `test/backend-test/test-installer-nsi.js` (pemeriksaan teks)

**Interfaces:**
- Consumes: folder rakitan Windows (Task 4), `tools/cli.js` (Task 2), `service.xml.template`.
- Produces: `installer/out/UptimeAccessControlT2-Setup-3.0.0-beta.0.exe`, `.sha256`, `BUILD-INFO.txt`.
- `installer.nsi`: Unicode, `RequestExecutionLevel admin`, `SetRegView 64`, bahasa Indonesia, `SetCompressor /SOLID lzma`, versi dari `/DVERSION=` (`3.0.0-beta.0`, bilangan `3.0.0.0` untuk `VIProductVersion`). Fungsi: `.onInit` (tolak 32-bit; `GetOptions` untuk `/PORT=`, `/AKSES=`; baca registri `HKLM\Software\UptimeAccessControlT2` untuk nilai awal dan `IsUpgrade`), halaman konfigurasi nsDialogs (kotak port, tiga radio akses; validasi bilangan 1–65535), bagian Pasang (urutan: hentikan dan hapus layanan lama bila ada → hapus `app\` dan `node\` bila upgrade → ekstrak → buat folder data/log tanpa menimpa isinya → bila upgrade `cli.js backup --label sebelum-upgrade` → `cli.js render-service` → `service\UptimeAccessControlT2.exe install` → `sc.exe config ... start= delayed-auto obj= "NT AUTHORITY\LocalService" password= ""` → `icacls` hak ubah `(OI)(CI)M` pada data dan log → aturan firewall menurut akses → `sc.exe start` → `cli.js wait --timeout 60` → pintasan Start Menu dan registri), bagian Uninstall (`un.` menghentikan dan menghapus layanan, `netsh advfirewall firewall delete rule name="Uptime Access Control T2"`, hapus program, pintasan, registri; `MessageBox` tanya hapus data dengan bawaan Tidak, `RMDir /r` data hanya sesudah jawaban Ya dan tidak pada mode senyap).

- [ ] **Step 1: Tulis tes teks (gagal)** yang membaca `installer.nsi`: `requests administrator and 64-bit registry`; `removes the old app and node folders only on upgrade`; `never removes the data folder before the question` (posisi `RMDir /r "$DATADIR"` sesudah `MessageBox` di bagian `un.`, dan terlindung `IfSilent`); `sets the service account and start mode with sc.exe config`; `deletes the firewall rule on uninstall`; `exits non-zero in silent mode when the service does not answer`; `uses the pinned version define`.
- [ ] **Step 2: Jalankan; harapkan GAGAL** (berkas belum ada).
- [ ] **Step 3: Pasang alat:** `apt-get install -y nsis p7zip-full`; periksa `makensis -VERSION`.
- [ ] **Step 4: Tulis `installer.nsi` dan `build.sh`** (`build.sh`: periksa alat → `assemble.sh win32` → `makensis -V2 -WX` → hitung SHA-256 → tulis `BUILD-INFO.txt` berisi versi dan hash komponen, jumlah berkas, ukuran, hash `package-lock.json`).
- [ ] **Step 5: Jalankan tes teks; harapkan LULUS.** Jalankan `installer/build.sh`; harapkan keluar 0 dan berkas `.exe` ada. Periksa `7z l` memuat `node/node.exe`, `app/server/server.js`, `service/UptimeAccessControlT2.exe`, `tools/cli.js`, `app/node_modules/better-sqlite3/build/Release/better_sqlite3.node`, dan tidak memuat `app/test`.
- [ ] **Step 6: Baca ulang `installer.nsi`, XML hasil render, dan `Pindahkan-Data.cmd` baris demi baris** terhadap dokumentasi NSIS/WinSW yang dikunci; catat temuan dan perbaikannya di ledger.
- [ ] **Step 7: Ledger.**

### Task 7: Panduan, dokumen Project, verifikasi akhir, dan penyerahan

**Files:**
- Create: `installer/README.md`
- Modify: dokumen Project `claude/fitur-scan-jaringan.md` (bagian fitur 8, daftar berkas)

**Interfaces:**
- Consumes: semua keluaran Task 1–6.

- [ ] **Step 1: Tulis `installer/README.md`** (Indonesia): cara memasang, mode senyap, pindah data, upgrade, uninstall, sembilan langkah uji Windows dari spesifikasi bagian 6, lokasi log, mengganti port atau akses (jalankan installer lagi), mengganti akun layanan, peringatan SmartScreen, dan cara membangun ulang (`installer/build.sh`).
- [ ] **Step 2: Verifikasi akhir:** `npm run test-backend` (harapkan seluruh suite hijau, ≥ 243 + tes baru), `eslint` dan `prettier --check installer test`, `installer/build.sh` dari awal, `sha256sum -c` pada keluaran, dan ulangi `run-linux.sh`.
- [ ] **Step 3: Serahkan:** salin `.exe`, `.sha256`, dan `BUILD-INFO.txt` ke `/mnt/user-data/outputs/windows-installer/`, kirim dengan `SendUserFile`; bila jembatan ke PC tersambung, tulis folder `installer/` ke `Monitoring Network\installer\` (tanpa `out/` dan `stage/`).
- [ ] **Step 4: Perbarui dokumen Project** dan ledger akhir (daftar Rulings dan Deferred minors).
