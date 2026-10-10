<div align="center" width="100%">
    <img src="./public/icon.svg" width="128" alt="Logo Uptime Access Control T2" />
</div>

# Uptime Access Control T2

Monitoring jaringan lokal untuk lingkungan operasional keamanan bandara (Terminal 2), dibangun sebagai fork pribadi dari [Uptime Kuma](https://github.com/louislam/uptime-kuma) 3.0.0-beta.0 (lisensi MIT, lihat `LICENSE`). Semua fitur Uptime Kuma tetap ada; yang ditambahkan adalah inventaris perangkat jaringan, pengelompokan per lokasi, laporan, dan alat bantu operasional.

> Ini proyek pribadi untuk jaringan T2, bukan rilis resmi Uptime Kuma. Jangan diajukan sebagai pull request ke repo upstream tanpa ditinjau sendiri.

## Fitur tambahan

**Inventaris dan scan jaringan** (menu profil → "Scan Jaringan", `/network-scan`)

- Scan rentang IP (CIDR, `a.b.c.d-e`, IP tunggal; maks 4096 alamat) dengan `ping` + tabel ARP + reverse DNS + vendor dari MAC. Hasilnya disimpan sebagai inventaris, lalu perangkat terpilih bisa dimasukkan ke monitoring.
- Tipe monitor perangkat: **Ping, port TCP, HTTP (dengan path), RTSP (kamera), SNMP (sysUpTime, community v2c)**.
- **Scan terjadwal** dan **perangkat asing**: perangkat baru atau IP yang tiba-tiba memakai MAC lain ditandai "Asing" dan dikirim sebagai notifikasi lewat provider notifikasi Kuma.
- Nama perangkat, **kategori dan sub kategori** (lokasi), filter kategori, dan aksi massal.
- Kategori terhubung dua arah dengan **grup monitor** di dashboard: kategori = grup tingkat atas, sub kategori = grup di dalamnya.

**Analisis dan laporan**

- Uptime per perangkat pada rentang waktu bebas, histori kejadian down, riwayat dan grafik ping, ekspor CSV.
- **Laporan bulanan Excel** (`.xlsx`: ringkasan per kategori, per perangkat, kejadian down), bisa diunduh atau disimpan otomatis ke folder pada tanggal 1 tiap bulan.
- **Wallboard** layar penuh untuk ruang kontrol (`/wallboard`, opsi `?kategori=A,B`), status per kategori, daftar perangkat down, alarm bunyi opsional.

**Pengelolaan data**

- **Impor** perangkat dari `.xlsx`, `.xls`, atau `.csv` (pemisah `,` `;` atau tab otomatis), dengan pratinjau per baris; **ekspor** inventaris ke Excel (kolom Community sengaja dikosongkan).
- **Peredam alert berantai**: perangkat bisa "bergantung pada" perangkat lain; alert DOWN ditahan bila induknya sedang down.
- **Backup otomatis `kuma.db`** (Pengaturan → Backup Database): jeda, jumlah salinan, folder, dan tombol "Backup sekarang".

**Tampilan**: tata letak lebih ringkas (font dan jarak dirapatkan), nama aplikasi "Uptime Access Control T2", bahasa Indonesia dan Inggris.

## Persyaratan

- Node.js **>= 26.2.0** (lihat `engines` di `package.json`)
- `ping` dan `arp` (atau `ip neigh`) tersedia di server untuk fitur scan
- SQLite (bawaan). Fitur backup otomatis hanya untuk SQLite.

## Menjalankan dari kode sumber

```bash
git clone https://github.com/seevent/Uptime-Access-Control-T2.git
cd Uptime-Access-Control-T2
npm install
npm run build
npm run start-server        # http://localhost:3001
```

Data disimpan di `data/` (`kuma.db`). **Cadangkan `data/kuma.db` sebelum memperbarui**, lalu jalankan `npm run build` dan restart server; migrasi database berjalan otomatis saat server mulai.

## Paket instalasi Windows

Folder [`installer/`](installer/README.md) berisi skrip untuk membangun `UptimeAccessControlT2-Setup-<versi>.exe` (NSIS, dibangun di Linux): server berjalan sebagai **layanan Windows** (WinSW), Node.js ikut dalam paket, data di `C:\ProgramData\UptimeAccessControlT2`, dan ada alat pemindah data lama.

```bash
installer/build.sh        # hasil: installer/out/*.exe (tidak disimpan di git)
```

Komponen unduhan (Node.js, WinSW, better-sqlite3) dikunci dengan SHA-256 di `installer/versions.json`; build berhenti bila tidak cocok. Panduan lengkap, daftar uji, dan cara upgrade ada di `installer/README.md`.

## Pengujian

```bash
npm run test-backend                                   # seluruh tes backend
node --import=tsx --test test/backend-test/test-network-*.js   # tes fitur jaringan
```

Tes fitur jaringan dan installer lulus di Linux (uji asap paket produksi juga lulus). Sebagian tes bawaan Uptime Kuma butuh Docker atau jaringan eksternal dan gagal di lingkungan terbatas.

**Belum teruji** di lingkungan nyata: pengiriman alert ke WhatsApp/Telegram, `ping`/ARP di jaringan T2, jalannya installer di Windows, wallboard di TV, dan impor `.xls` dari Excel asli (pembaca `.xls` baru dicocokkan dengan file buatan LibreOffice).

## Struktur singkat

| Lokasi                                                                             | Isi                                                                   |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `server/network-*.js`, `server/database-backup.js`, `server/xlsx-writer.js`        | logika fitur jaringan, laporan, backup                                |
| `server/socket-handlers/network-scan-socket-handler.js`                            | event Socket.IO fitur jaringan                                        |
| `src/pages/NetworkScan.vue`, `NetworkWallboard.vue`, `src/components/Network*.vue` | halaman dan dialog                                                    |
| `src/network-*.js`                                                                 | pembaca CSV/`.xls`/Excel, agregasi, format                            |
| `db/knex_migrations/2026-10-*`                                                     | migrasi tabel `network_device`, `network_category`, dan kolom terkait |
| `installer/`                                                                       | paket instalasi Windows                                               |
| `test/backend-test/test-network-*.js`, `test-installer-*.js`                       | tes                                                                   |

## Catatan keamanan

- Ekspor inventaris tidak menyertakan community SNMP. Community tetap tersimpan di database monitor; lindungi `data/kuma.db` dan file backup-nya.
- Di jaringan tanpa internet, layanan Windows menyetel `KUMA_SKIP_HIBP=1` agar pembuatan admin tidak gagal karena pengecekan kata sandi online; pilih kata sandi yang kuat.

## Lisensi dan atribusi

MIT, mengikuti Uptime Kuma. Hak cipta kode asli © Louis Lam dan kontributor Uptime Kuma; perubahan fork ini untuk keperluan internal. Dokumentasi, wiki, dan laporan masalah Uptime Kuma asli: <https://github.com/louislam/uptime-kuma>.
