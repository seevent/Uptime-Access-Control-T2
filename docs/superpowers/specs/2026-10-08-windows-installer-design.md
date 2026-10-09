# Paket instalasi Windows untuk server pemantau (fitur 8)

Tanggal: 8 Okt 2026. Menyediakan satu berkas `UptimeAccessControlT2-Setup-<versi>.exe` yang memasang aplikasi ini sebagai layanan Windows di PC yang menyala terus (server pemantau di T2), ditambah skrip untuk memindahkan data dari instalasi lama. Tidak ada perubahan pada kode aplikasi, tabel, atau migrasi; semua yang baru ada di folder `installer/`.

## Keputusan pengguna

- Tujuan: server pemantau yang menyala terus, jadi aplikasi berjalan sebagai Windows Service (bukan pintasan yang jalan saat login).
- Data lama (`Monitoring Network\data`) dibawa lewat skrip pindah data terpisah; installer sendiri memasang server bersih.
- Installer dibangun di sini (Linux) dengan NSIS dan diserahkan sebagai berkas `.exe` jadi. Uji penuh di Windows baru terjadi saat pengguna mencobanya pertama kali.

## Temuan dari proyek

- Server dijalankan dengan `node --import=tsx server/server.js`; `tsx` adalah dependensi produksi. Server mengimpor `../src/util` (21 tempat), jadi folder `src` ikut dibawa. Frontend sudah jadi di `dist` (4 MB); Vite, Vue, dan dependensi dev lain tidak dibawa.
- Pohon dependensi produksi 601 paket. Komponen native: `better-sqlite3` (skrip `prebuild-install`), `esbuild` (lewat `tsx`; binary ada di paket opsional `@esbuild/<platform>`). `oracledb` membawa binary semua platform sendiri; `ssh2` dan `cpu-features` punya cadangan JavaScript; `protobufjs` hanya skrip pemeriksa versi.
- `package.json` meminta Node `>= 26.2.0`; `better-sqlite3` 12.11.1 mendukung Node 20–26. Semua tes lulus di sini dengan Node 26.10.0.
- Konfigurasi lewat lingkungan sudah didukung: `DATA_DIR`, `UPTIME_KUMA_PORT`, `UPTIME_KUMA_HOST`, `UPTIME_KUMA_DB_TYPE`. Dengan `UPTIME_KUMA_DB_TYPE=sqlite`, `setup-database.js` menulis `db-config.json` sendiri dan tidak menampilkan layar pilih database. `authSecret` dibuat sendiri oleh `better-auth.ts` bila belum ada.
- `data\db-config.json` berisi `authSecret`. Memindahkan `kuma.db` tanpa berkas itu membuat sesi login tidak berlaku dan bisa membuat data yang dienkripsi dengan rahasia itu (mis. 2FA) tidak terbaca.
- Server memasang `http-graceful-shutdown` untuk `SIGINT` dan `SIGTERM`.
- `AGENTS.md` (pemberitahuan upstream tentang PR) tidak berlaku: ini fork pribadi dan tidak ada PR.

## 1. Isi paket dan tata letak di Windows

Program: `C:\Program Files\Uptime Access Control T2\`

- `node\` : Node.js 26.10.0 win-x64 portabel (hanya `node.exe` dan lisensinya).
- `app\` : `server`, `src`, `db`, `dist`, `extra`, `package.json`, `package-lock.json`, `LICENSE`, dan `node_modules` produksi untuk Windows. Tidak ikut: `test`, `docs`, `data`, `tmp`, `.git`, dan semua dependensi dev.
- `service\` : `UptimeAccessControlT2.exe` (WinSW) dan `UptimeAccessControlT2.xml` (dibuat installer dari templat).
- `tools\` : `Pindahkan-Data.cmd`, `cli.js`, `data.js`, `service.js`.
- `LICENSES\` : lisensi Uptime Kuma (MIT), Node.js, WinSW.

Data: `C:\ProgramData\UptimeAccessControlT2\data` (`DATA_DIR`), log layanan di `C:\ProgramData\UptimeAccessControlT2\logs`, cadangan di `...\data\backup`. Data tidak pernah ditulis di folder program, sehingga upgrade dan uninstall tidak menyentuhnya.

## 2. Layanan Windows

Pembungkus: WinSW 2.x (build .NET Framework 4, x64), MIT. Versi persisnya dikunci di `installer/versions.json` dengan SHA-256 setelah diperiksa asal-usulnya (rilis resmi proyek, bukan salinan pihak ketiga). Bila berkas tidak bisa diunduh atau tidak cocok dengan checksum, build berhenti dan dilaporkan; tidak ada pengganti diam-diam.

Konfigurasi (templat `installer/service.xml.template`):

- `id` `UptimeAccessControlT2`, nama tampil "Uptime Access Control T2".
- Perintah: `node\node.exe --import=tsx server/server.js`, direktori kerja `app\`.
- Lingkungan: `NODE_ENV=production`, `DATA_DIR`, `UPTIME_KUMA_PORT`, `UPTIME_KUMA_DB_TYPE=sqlite`, dan `UPTIME_KUMA_HOST=127.0.0.1` hanya bila akses dibatasi ke PC ini.
- Gagal/mati: dihidupkan lagi 10 detik kemudian (tiga kali), lalu 60 detik; penghitung gagal direset setelah 1 jam. Batas waktu berhenti 20 detik. Log dirotasi per ukuran (10 MB, simpan 8 berkas).
- Setelah `install`, installer menjalankan `sc.exe config` untuk mode mulai "otomatis tertunda" (jaringan sudah siap) dan akun `NT AUTHORITY\LocalService`, lalu memberi akun itu hak ubah pada folder data dan log lewat `icacls`. `ping` dan `arp` yang dipakai scan dan monitor tidak butuh hak admin.
- Berhenti dengan rapi bergantung pada WinSW mengirim Ctrl+C ke Node; perilaku ini hanya bisa dipastikan di Windows. Bila gagal, proses dimatikan paksa setelah 20 detik, yang aman bagi SQLite dalam mode WAL.

## 3. Installer (NSIS, 64-bit, Windows 10/11 dan Server 2016 ke atas, bahasa Indonesia)

Halaman: sambutan, lisensi, folder tujuan, **konfigurasi** (port, bawaan 3001; akses: "hanya PC ini", "PC di subnet yang sama" sebagai bawaan, atau "semua jaringan"), proses, selesai. Halaman selesai memuat tombol buka `http://localhost:<port>`.

Pasang baru: salin berkas; buat folder data/log bila belum ada (isinya tidak pernah ditimpa); tulis XML layanan; `install` layanan; atur akun dan hak; buat aturan firewall masuk "Uptime Access Control T2" untuk TCP pada port itu (`remoteip=LocalSubnet`, `Any` bila "semua jaringan", tanpa aturan bila "hanya PC ini"; semua profil, terikat pada `node.exe`); mulai layanan; tunggu sampai `http://127.0.0.1:<port>` menjawab (maks 60 detik) dan tampilkan hasilnya, termasuk lokasi log bila tidak menjawab; buat pintasan Start Menu "Buka Uptime Access Control T2" dan "Pindahkan data lama"; catat di `HKLM\Software\UptimeAccessControlT2` (InstallDir, Port, Akses, Versi) dan entri Add/Remove Programs.

Upgrade (menjalankan installer di atas instalasi yang ada): port dan akses dibaca dari registri sebagai nilai awal; layanan dihentikan dan dihapus; `kuma.db` (beserta `-wal`, `-shm`) dan `db-config.json` disalin ke `data\backup\sebelum-upgrade-<tanggal-jam>`; folder `app\` dan `node\` dihapus lalu diganti seluruhnya (agar tidak ada berkas versi lama yang tertinggal); layanan dipasang lagi dan dimulai. Folder data tidak disentuh; migrasi database berjalan otomatis saat layanan start.

Uninstall: hentikan dan hapus layanan, hapus aturan firewall, hapus program dan pintasan, hapus kunci registri. Lalu tanya "Hapus juga data (database, log, cadangan)?" dengan bawaan Tidak. Pada uninstall senyap data selalu dipertahankan.

Mode senyap: `Setup.exe /S /PORT=3001 /AKSES=subnet|lokal|semua [/D=C:\...]`. Kode keluar bukan nol bila layanan tidak menjawab dalam batas waktu. Installer meminta hak administrator dan menolak berjalan di Windows 32-bit.

## 4. Pindah data lama (`tools\Pindahkan-Data.cmd`)

`Pindahkan-Data.cmd` meminta hak administrator sendiri, lalu menjalankan `node\node.exe tools\cli.js migrate`. Logikanya ada di modul Node yang bisa diuji di Linux (`tools\data.js` untuk cadangan dan pindah data, `tools\service.js` untuk kontrol layanan, pembuatan XML layanan, dan penantian HTTP, `tools\cli.js` sebagai pintu masuk); kontrol layanan disuntikkan sehingga tes memakai tiruan. Installer memanggil modul yang sama untuk membuat XML layanan, mencadangkan data saat upgrade, dan menunggu layanan menjawab, sehingga bagian yang tidak bisa saya uji (skrip NSIS) sekecil mungkin.

Alur:

1. Minta lokasi folder data lama (contoh: `...\Monitoring Network\data`) atau menerimanya sebagai argumen. Folder harus berisi `kuma.db`; folder yang sama dengan folder data baru ditolak.
2. Periksa apakah Kuma lama masih menulis: bila `kuma.db-wal` berubah dalam 15 detik terakhir, berhenti dengan pesan "hentikan Kuma lama dulu" kecuali `--force`. Lalu minta konfirmasi (`--yes` melewati).
3. Hentikan layanan baru; salin data baru yang ada (`kuma.db*`, `db-config.json`, `upload`) ke `data\backup\sebelum-pindah-<tanggal-jam>`.
4. Salin database dengan API backup SQLite (hasilnya satu berkas yang konsisten, walau sumbernya memakai WAL), salin `db-config.json` (membawa `authSecret`), `upload`, dan `screenshots`.
5. Periksa hasil: `PRAGMA integrity_check` pada salinan dan jumlah baris `monitor` dan `heartbeat` sama dengan sumber. Bila gagal di langkah mana pun, data baru dikembalikan dari cadangan dan layanan dinyalakan lagi dengan pesan galat.
6. Nyalakan layanan dan tampilkan ringkasan: jumlah monitor, heartbeat, perangkat jaringan, kategori. Folder lama tidak dihapus atau diubah.

## 5. Pembangunan (`installer/build.sh`, dijalankan di Linux)

Langkah, berhenti di galat pertama:

1. Periksa alat (`makensis`, `node` 26, `npm`, `tar`, `unzip`, `sha256sum`).
2. Ambil dan verifikasi: Node win-x64 zip (cocokkan SHA-256 dengan `SHASUMS256.txt` dari nodejs.org dan dengan nilai terkunci), WinSW, binary `better-sqlite3` untuk `win32-x64` Node 26.10.0 (lewat `prebuild-install --platform win32 --arch x64 --runtime node --target 26.10.0`; hash dicatat pada build pertama dan diperiksa pada build berikutnya).
3. Rakit `app\` dari daftar berkas yang ada di `installer/app-files.txt`, lalu `npm ci --omit=dev --ignore-scripts --os=win32 --cpu=x64` di folder rakitan. Binary `better-sqlite3` Windows diletakkan di `build/Release`. Binary platform lain milik `oracledb` dipangkas.
4. Periksa isi rakitan: `@esbuild/win32-x64` ada; `better_sqlite3.node` adalah PE x64 (cek header MZ/PE dan mesin 0x8664); tidak ada berkas `.node` Linux/macOS yang tersisa selain yang sengaja dipertahankan; tidak ada `node_modules/.bin` Linux yang menunjuk ke luar.
5. Kompilasi `installer.nsi` dengan `makensis` (pemadatan lzma solid). Keluaran: `installer/out/UptimeAccessControlT2-Setup-3.0.0-beta.0.exe`, berkas `.sha256`, dan `BUILD-INFO.txt` (versi komponen, hash, jumlah berkas, ukuran, hash `package-lock.json`).

Versi komponen dan hash disimpan di `installer/versions.json`. Unduhan hanya dari sumber resmi: nodejs.org, rilis GitHub WinSW, rilis GitHub `WiseLibs/better-sqlite3`, dan registri npm.

## 6. Pengujian

Yang saya uji di sini:

- `data.js`, `service.js`, dan `cli.js` dengan tes otomatis (`test/backend-test/test-installer-*.js`): salinan dari database WAL yang masih punya data di berkas `-wal`; `db-config.json` dan `authSecret` ikut; `upload` ikut; folder sumber yang sama dengan tujuan ditolak; sumber tanpa `kuma.db` ditolak; WAL yang baru berubah ditolak tanpa `--force`; cadangan data baru dibuat; kegagalan di tengah (disuntikkan) mengembalikan data baru dan menyalakan layanan lagi; ringkasan jumlah benar.
- Rakitan "paket produksi": file yang sama dan `npm ci --omit=dev` versi Linux dijalankan dengan `DATA_DIR` sementara dan `UPTIME_KUMA_DB_TYPE=sqlite`; periksa tanpa `MODULE_NOT_FOUND`, `GET /` menjawab, buat admin, masuk, buka `/network-scan`, jalankan scan 127.0.0.1/32 di browser. Ini membuktikan bahwa daftar berkas dan dependensi produksi cukup.
- Pemeriksaan isi rakitan Windows (langkah 4 build), daftar isi installer (`7z l`), kompilasi NSIS tanpa peringatan, dan checksum.
- Pembacaan ulang `installer.nsi`, XML layanan, dan `.cmd` baris demi baris terhadap dokumentasi WinSW dan NSIS yang dikunci.

Yang tidak bisa saya uji dari sini (Windows diperlukan): jalannya installer, layanan WinSW, akun LocalService dan hak foldernya, aturan firewall, penghentian rapi, `ping` dan `arp` Windows di scan, Pindahkan-Data.cmd. Daftar uji untuk pengguna pada mesin Windows bersih (mesin virtual lebih baik):

1. Pasang dengan bawaan; halaman selesai menunjukkan layanan menjawab.
2. Buka `http://localhost:3001`, buat admin, tambah satu monitor Ping.
3. Jalankan scan jaringan untuk satu rentang kecil dan periksa kolom MAC terisi.
4. Mulai ulang PC; layanan hidup sendiri dan monitor tetap ada.
5. Hentikan layanan di `services.msc`; lihat di log layanan apakah ada baris "graceful shutdown".
6. Dari PC lain di subnet yang sama, buka alamat server (aturan firewall).
7. Jalankan installer yang sama lagi (simulasi upgrade); data dan port tetap, cadangan terbentuk.
8. Jalankan "Pindahkan data lama" dari folder `Monitoring Network\data` setelah Kuma lama dihentikan; monitor dan kategori lama muncul.
9. Uninstall dengan memilih "pertahankan data"; pasang lagi; data masih ada.

## 7. Batas, risiko, dan keputusan saya

- **Tanpa tanda tangan kode**: Windows SmartScreen akan memberi peringatan dan AppLocker atau antivirus bisa memblokir `.exe`. Tanda tangan bisa ditambahkan nanti (satu langkah di build) bila ada sertifikat.
- **WinSW** membutuhkan .NET Framework 4.x (ada di Windows 10/11 dan Server 2016+).
- **Ukuran**: diperkirakan 60–120 MB; angka pasti dilaporkan di `BUILD-INFO.txt`.
- Keputusan: Node 26.10.0 (versi yang sama dengan yang dites di sini); NSIS bukan Inno Setup (bisa dikompilasi di Linux); akun LocalService bukan SYSTEM (hak lebih kecil; bila ada masalah izin, bisa diganti di `services.msc`); mulai otomatis tertunda; `UPTIME_KUMA_DB_TYPE=sqlite` lewat lingkungan agar tak ada layar pilih database; aturan firewall bawaan hanya untuk subnet lokal; cadangan otomatis sebelum upgrade dan sebelum pindah data; installer berbahasa Indonesia.
- Di luar lingkup: pembaruan otomatis, banyak instans, MariaDB tertanam, tanda tangan kode, instalasi 32-bit atau ARM, dan pengujian di Windows dari sini.

## 8. Berkas

Baru: `installer/build.sh`, `installer/versions.json`, `installer/app-files.txt`, `installer/installer.nsi`, `installer/service.xml.template`, `installer/lib/` (`check-payload.js`, `fetch.sh`, `assemble.sh`), `installer/smoke/`, `installer/payload/tools/` (`data.js`, `service.js`, `cli.js`, `Pindahkan-Data.cmd`), `installer/README.md` (panduan operator), dan tes `test/backend-test/test-installer-{data,service,payload,nsi}.js`. Tidak ada berkas aplikasi yang diubah. Dokumen Project `claude/fitur-scan-jaringan.md` diperbarui setelah selesai.
