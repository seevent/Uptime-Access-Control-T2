# Paket instalasi Windows: Uptime Access Control T2

Folder ini berisi semua yang dibutuhkan untuk membangun dan memakai installer Windows (server pemantau yang berjalan 24 jam sebagai layanan Windows). Installer dibangun di Linux; **jalannya installer di Windows belum pernah diuji**, jadi lakukan daftar uji di bagian "Uji di Windows" sebelum dipakai sungguhan.

## Status build

Ketiga komponen unduhan sudah terkunci di `versions.json` dan `build.sh` menghasilkan `.exe`:

- **Node.js 26.10.0**: `node.exe` diambil dari paket npm `node-win-x64` dan hanya dipakai bila SHA-256-nya sama persis dengan baris `win-x64/node.exe` di `https://nodejs.org/dist/v26.10.0/SHASUMS256.txt` (hash resmi). Tanpa itu build berhenti.
- **WinSW 2.12.0**: hash sama dengan unduhan langsung dari rilis GitHub dan manifest Scoop (rilis ini tidak memuat digest GitHub).
- **better-sqlite3 12.11.1 (win32-x64)**: hash sama dengan digest di halaman rilis GitHub.

Membangun ulang: `installer/build.sh` (butuh `makensis`, `7z`, Node 22+, `npm`, `tar`, `unzip`, `openssl`, `sha256sum`, `python3`, dan akses ke registry npm serta github.com). Bila ada versi yang diganti, kunci ulang hash-nya di `versions.json` dari sumber resmi.

Catatan: aplikasi membaca `KUMA_SKIP_HIBP=1` di `server/better-auth.ts` (dengan tes di `test-installer-service.js`). Tanpa itu, pembuatan admin di jaringan tanpa internet gagal.

## Memasang

Jalankan `UptimeAccessControlT2-Setup-<versi>.exe` sebagai administrator (Windows 10/11 atau Server 2016 ke atas, 64-bit). Halaman konfigurasi menanyakan:

- **Port** halaman web (bawaan 3001).
- **Akses**: "Hanya PC ini" (server hanya mendengar di 127.0.0.1, tanpa aturan firewall), "PC di subnet yang sama" (bawaan; aturan firewall masuk dengan `remoteip=LocalSubnet`), atau "Semua jaringan".

Lokasi:

- Program: `C:\Program Files\Uptime Access Control T2\` (`node\`, `app\`, `service\`, `tools\`, `LICENSES\`).
- Data: `C:\ProgramData\UptimeAccessControlT2\data` (database `kuma.db`, `db-config.json`, `upload`), cadangan di `data\backup\`.
- Log layanan: `C:\ProgramData\UptimeAccessControlT2\logs` (dirotasi 10 MB, 8 berkas).

Layanan bernama `UptimeAccessControlT2` ("Uptime Access Control T2"), akun `NT AUTHORITY\LocalService`, mulai otomatis tertunda, dinyalakan lagi sendiri bila mati (10 detik tiga kali, lalu 60 detik).

Setelah terpasang buka `http://localhost:<port>`. Pembuatan akun admin pertama hanya terbuka 10 menit sejak server pertama kali diakses; bila lewat, jalankan `Restart-Service UptimeAccessControlT2` di PowerShell (administrator) lalu buat admin.

### Mode senyap

```
UptimeAccessControlT2-Setup-3.0.0-beta.0.exe /S /PORT=3001 /AKSES=subnet [/D=C:\folder\tujuan]
```

`/AKSES=` berisi `lokal`, `subnet`, atau `semua`. `/D=` hanya berlaku untuk pemasangan baru; pada upgrade, installer selalu memakai folder instalasi yang sudah terdaftar. Kode keluar: 0 berhasil; 2 argumen tidak valid; 3 layanan tidak menjawab dalam 60 detik; 4 bukan Windows 64-bit atau terlalu lama; 5 salah satu langkah pemasangan gagal; 6 port sudah dipakai program lain (mis. Kuma lama yang masih berjalan).

### Mengganti port atau akses, upgrade

Jalankan installer lagi. Port, akses, dan folder dibaca dari instalasi yang ada sebagai nilai awal. Urutannya: layanan lama dihentikan sampai benar-benar berhenti, database dicadangkan ke `data\backup\sebelum-upgrade-<tanggal-jam>` (bila pencadangan gagal, layanan lama dinyalakan lagi dan tidak ada yang diubah), baru layanan lama dihapus, `app\`, `node\`, `service\`, `tools\` diganti seluruhnya, dan layanan baru dipasang. Bila langkah konfigurasi sesudah `install` gagal, layanan setengah jadi dihapus lagi; data tidak disentuh. Pencadangan juga dibuat pada pemasangan baru yang menemukan data sisa (mis. sesudah uninstall dengan data dipertahankan).

### Uninstall

Dari Settings > Apps, atau "Hapus Uptime Access Control T2" di Start Menu. Layanan, aturan firewall, program, pintasan, dan registri dihapus; lalu ditanya apakah data ikut dihapus (bawaan **Tidak**). Uninstall senyap (`/S`) selalu mempertahankan data.

### Memindahkan data dari Kuma lama

1. Hentikan Kuma lama sampai prosesnya benar-benar berhenti.
2. Start Menu > "Pindahkan data lama" (atau `tools\Pindahkan-Data.cmd`; meminta hak administrator sendiri, argumen tidak diteruskan saat meningkatkan hak).
3. Masukkan folder data lama, mis. `C:\Users\Yuli Syarif\Downloads\Monitoring Network\data`, lalu jawab `y`.

Alat ini menghentikan layanan baru, mencadangkan data baru ke `data\backup\sebelum-pindah-<tanggal-jam>`, menyalin database dengan API backup SQLite (baris yang baru ada di `kuma.db-wal` ikut), `db-config.json` (membawa `authSecret`, sehingga login lama tetap berlaku), `upload`, dan `screenshots`, memeriksa hasilnya (`integrity_check` dan jumlah baris), lalu menyalakan layanan. Bila gagal, data baru dikembalikan dari cadangan. Folder lama tidak diubah. Opsi: `--source <folder>`, `--yes`, `--force` (abaikan pemeriksaan bahwa Kuma lama masih menulis).

## Catatan penting

- **Cek kata sandi online dimatikan.** Layanan memakai `KUMA_SKIP_HIBP=1`: aplikasi biasanya mencocokkan kata sandi baru ke layanan kebocoran data di internet, dan pembuatan admin gagal ("Failed to check password") di jaringan tanpa internet. Pilih kata sandi yang kuat. Untuk menyalakan kembali (server perlu internet) hapus baris itu dari `service\UptimeAccessControlT2.xml` lalu `Restart-Service UptimeAccessControlT2`.
- **Tanpa tanda tangan kode**: SmartScreen menampilkan "Windows protected your PC" (More info > Run anyway); AppLocker atau antivirus bisa memblokir.
- Layanan butuh .NET Framework 4.x (ada di Windows 10/11 dan Server 2016+).
- **Hak akses data**: folder `C:\ProgramData\UptimeAccessControlT2` hanya bisa dibuka SYSTEM, Administrators, dan LocalService (pengguna biasa tidak), karena berisi hash kata sandi dan rahasia sesi. Akun lain yang perlu membaca log harus ditambahkan sendiri.
- **Pembatas pencarian modul**: layanan memuat `app\uac-guard.cjs` lebih dulu, supaya Node tidak memuat modul tiruan yang ditaruh pengguna lokal di `C:\node_modules`.
- Mengganti akun layanan (bila ada masalah izin): `services.msc` > Uptime Access Control T2 > Log On; akun baru harus punya hak ubah pada folder data dan log.
- Mengubah port atau akses sebaiknya lewat installer (juga menyesuaikan firewall), bukan dengan mengedit XML.

## Uji di Windows (mesin bersih, mesin virtual lebih baik)

1. Pasang dengan bawaan; halaman selesai menunjukkan layanan menjawab.
2. Buka `http://localhost:3001`, buat admin, tambah satu monitor Ping.
3. Jalankan scan jaringan untuk satu rentang kecil dan periksa kolom MAC terisi.
4. Mulai ulang PC; layanan hidup sendiri dan monitor tetap ada.
5. Hentikan layanan di `services.msc`; lihat di log layanan apakah ada baris "graceful shutdown".
6. Dari PC lain di subnet yang sama, buka alamat server (aturan firewall).
7. Jalankan installer yang sama lagi (simulasi upgrade); data dan port tetap, cadangan terbentuk.
8. Jalankan "Pindahkan data lama" dari folder `Monitoring Network\data` setelah Kuma lama dihentikan; monitor dan kategori lama muncul.
9. Uninstall dengan memilih "pertahankan data"; pasang lagi; data masih ada.

Bila ada langkah yang gagal, kirimkan isi `C:\ProgramData\UptimeAccessControlT2\logs` dan tampilan jendela pemasangan.

## Membangun ulang (di Linux)

Alat: `makensis` (NSIS 3), `7z`, Node 22+, `npm`, `tar`, `unzip`, `sha256sum`, `python3`.

```
installer/build.sh
```

Langkah: merakit `app\` dari `app-files.txt` dengan `npm ci --omit=dev --ignore-scripts --os=win32 --cpu=x64`, mengambil dan memverifikasi komponen (`lib/fetch.sh`), memeriksa isi rakitan (`lib/check-payload.js`), mengompilasi `installer.nsi` dengan `makensis -V2 -WX`, memeriksa isi dengan `7z l`, lalu menulis `installer/out/*.exe`, `.sha256`, dan `BUILD-INFO.txt`.

Uji otomatis (tanpa Windows): `npm run test-backend` (berkas `test-installer-*.js`) dan uji asap paket produksi di Linux: `installer/lib/assemble.sh linux /tmp/stage-linux && installer/smoke/run-linux.sh /tmp/stage-linux` (butuh Playwright untuk Python dengan Chromium).
