/**
 * ============================================================================
 * GOOGLE APPS SCRIPT BACKEND - AZI CELL (Code.gs) v1.0.2
 * ============================================================================
 * CARA DEPLOY DI AKUN ANDA (DAN SAAT SERAH TERIMA KE PEMILIK BARU):
 * 1. Buka Google Spreadsheet > Extensions > Apps Script.
 * 2. Tempel seluruh kode ini, pastikan SPREADSHEET_ID sesuai milik Anda,
 *    lalu simpan (Ctrl+S).
 * 3. Pilih fungsi "setupDatabaseOtomatis" di toolbar atas lalu klik "Run"
 *    untuk membuat 12 Sheet, Header Judul, Akun Kas, Pengaturan, dan
 *    2 Akun bawaan (owner & kasir) secara otomatis.
 * 4. Klik "Deploy" > "New deployment" (atau "Manage deployments" > Edit > New version):
 *    - Type: Web app
 *    - Execute as: Me (Akun Anda / Pemilik)
 *    - Who has access: Anyone (Siapa saja)
 * 5. Salin URL Web App (https://script.google.com/macros/s/.../exec)
 *    lalu tempelkan ke GAS_WEB_APP_URL di file config.js (atau menu Pengaturan).
 * ============================================================================
 */

// [WAJIB GANTI KE ID SPREADSHEET PEMILIK SAAT SERAH TERIMA APLIKASI]
const SPREADSHEET_ID = '1WH_nBZ7vsXp2lurFDKZV7TL1pqnrfLD27cax85m4-d8';
const BACKEND_VERSION = '1.0.6';
// Keamanan: kunci target hanya ke SPREADSHEET_ID pemilik agar tidak bisa dialihkan pihak luar
const ALLOW_CUSTOM_SPREADSHEET_ID = false;

const SHEET_SCHEMA = {
  Pengaturan: [
    'Kunci', 'Nilai', 'Keterangan', 'Diperbarui_Oleh', 'Waktu_Update'
  ],
  Karyawan: [
    'ID_Karyawan', 'Username', 'Password_Hash', 'Nama_Lengkap', 'Jabatan',
    'Kontak', 'Status_Aktif', 'Wajib_Ganti_Password', 'Hak_Akses_JSON',
    'Dibuat_Pada', 'Diperbarui_Pada'
  ],
  Akun_Kas: [
    'ID_Akun', 'Nama_Akun', 'Tipe_Akun', 'Saldo_Awal', 'Total_Masuk',
    'Total_Keluar', 'Saldo_Akhir', 'Status_Aktif', 'Diperbarui_Pada'
  ],
  Barang_Stok: [
    'Kode_SKU', 'Barcode', 'Nama_Barang', 'Kategori', 'Satuan',
    'Harga_Modal', 'Harga_Jual', 'Stok_Awal', 'Unit_Masuk', 'Unit_Keluar',
    'Stok_Akhir', 'Stok_Minimum', 'Pemasok', 'Status_Aktif', 'Catatan',
    'Diperbarui_Pada'
  ],
  Riwayat_Stok: [
    'ID_Mutasi', 'Waktu', 'Kode_SKU', 'Nama_Barang', 'Jenis_Gerakan',
    'Sumber_Referensi', 'Jumlah_Masuk', 'Jumlah_Keluar', 'Stok_Sebelum',
    'Stok_Sesudah', 'Harga_Modal_Satuan', 'Alasan_Catatan', 'Petugas'
  ],
  Pembelian: [
    'No_Pembelian', 'Tanggal', 'Nama_Pemasok', 'No_Referensi_Nota', 'Item_JSON',
    'Total_Pembelian', 'Jumlah_Dibayar', 'Sisa_Utang', 'Status_Bayar',
    'ID_Akun_Kas', 'Jatuh_Tempo', 'Petugas', 'Catatan'
  ],
  Penjualan: [
    'No_Transaksi', 'Tanggal_Jam', 'Status_Dokumen', 'Nama_Pelanggan',
    'Kontak_Pelanggan', 'Item_JSON', 'Jasa_JSON', 'Total_Jasa', 'Subtotal',
    'Diskon', 'Total_Akhir', 'Total_Modal_Historis', 'Laba_Kotor',
    'Metode_Bayar', 'ID_Akun_Kas', 'Uang_Diterima', 'Kembalian',
    'Jumlah_Terbayar', 'Sisa_Piutang', 'Status_Bayar', 'Jatuh_Tempo',
    'Petugas', 'Catatan'
  ],
  Servis: [
    'No_Servis', 'Tanggal_Terima', 'Tanggal_Selesai', 'Tanggal_Diambil',
    'Nama_Pelanggan', 'Kontak_Pelanggan', 'Perangkat_Barang', 'Merek_Model',
    'Keluhan', 'Jenis_Servis', 'Kondisi_Kelengkapan', 'Status_Pengerjaan',
    'Tindakan_Teknisi', 'Sparepart_JSON', 'Total_Sparepart', 'Total_Modal_Part',
    'Nama_Jasa', 'Biaya_Jasa', 'Jasa_JSON', 'Diskon', 'Estimasi_Biaya',
    'Total_Biaya_Final', 'DP_Awal', 'Total_Terbayar', 'Sisa_Tagihan',
    'Status_Bayar', 'Stok_Part_Terpotong', 'Alasan_Batal', 'Teknisi',
    'Petugas_Terima'
  ],
  Pembayaran_Tagihan: [
    'ID_Pembayaran', 'Tanggal_Jam', 'Jenis_Tagihan', 'No_Referensi',
    'Pihak_Terkait', 'Total_Tagihan_Awal', 'Sudah_Dibayar_Sebelumnya',
    'Nominal_Bayar', 'Sisa_Tagihan_Akhir', 'Metode_Bayar', 'ID_Akun_Kas',
    'Ref_Transfer_QRIS', 'Status_Konfirmasi', 'Petugas', 'Catatan'
  ],
  Kas_Modal: [
    'ID_Kas', 'Tanggal_Jam', 'Jenis_Arus', 'Kategori', 'ID_Akun_Asal',
    'ID_Akun_Tujuan', 'Nominal', 'No_Referensi', 'Keterangan', 'Bukti_URL',
    'Petugas'
  ],
  Retur_Koreksi: [
    'ID_Retur', 'Tanggal_Jam', 'Jenis_Koreksi', 'No_Transaksi_Asal',
    'Item_JSON', 'Kondisi_Barang', 'Kembali_Ke_Stok', 'Nilai_Koreksi_Omzet',
    'Nilai_Koreksi_Modal', 'Metode_Penyelesaian_Dana',
    'Nominal_Refund_Potong_Tagihan', 'ID_Akun_Kas', 'Alasan', 'Petugas'
  ],
  Log_Audit: [
    'ID_Log', 'Waktu', 'Username_Pelaku', 'Aksi', 'Target_Objek',
    'Detail_Perubahan', 'IP_Perangkat'
  ]
};

// Kolom yang wajib diformat sebagai teks polos (@) agar angka 0 di depan no HP / barcode tidak hilang
const TEXT_FORMAT_COLUMNS = {
  Karyawan: [1, 2, 3, 6],
  Barang_Stok: [1, 2],
  Pembelian: [1, 4],
  Penjualan: [1, 5],
  Servis: [1, 6],
  Pembayaran_Tagihan: [1, 4, 12],
  Kas_Modal: [1, 8],
  Retur_Koreksi: [1, 4],
  Log_Audit: [1]
};

function nowWib() {
  return Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd HH:mm');
}

function safeNum(val, fallback) {
  if (val === null || val === undefined || val === '') return fallback !== undefined ? fallback : 0;
  const n = Number(val);
  return isNaN(n) ? (fallback !== undefined ? fallback : 0) : n;
}

function safeJsonParse(str, fallback) {
  if (!str) return fallback;
  if (typeof str === 'object') return str;
  try {
    return JSON.parse(String(str));
  } catch (e) {
    return fallback;
  }
}

function safeText(val, fallback) {
  const s = (val === null || val === undefined || val === '') ? (fallback !== undefined ? String(fallback) : '') : String(val);
  const trimmed = s.trim();
  if (trimmed === '' || trimmed === '-') return s;
  // Cegah Formula Injection di Google Sheets (=, +, @, atau - yang bukan angka negatif murni)
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d+(\.\d+)?$/.test(trimmed))) {
    return "'" + s;
  }
  return s;
}

function getTargetSpreadsheet(customId) {
  const idToOpen = (ALLOW_CUSTOM_SPREADSHEET_ID && customId && String(customId).trim() !== '')
    ? String(customId).trim()
    : SPREADSHEET_ID;
  try {
    return SpreadsheetApp.openById(idToOpen);
  } catch (err) {
    return SpreadsheetApp.getActiveSpreadsheet();
  }
}

function styleHeaderRow(sheet, headers) {
  const range = sheet.getRange(1, 1, 1, headers.length);
  range.setValues([headers]);
  range
    .setBackground('#0F172A')
    .setFontColor('#F8FAFC')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.setFrozenRows(1);
}

/**
 * Cepat: hanya membuat sheet yang belum ada atau memperbarui header jika skema bertambah kolom.
 */
function ensureSchemaFast(ss) {
  Object.keys(SHEET_SCHEMA).forEach((sheetName) => {
    const headers = SHEET_SCHEMA[sheetName];
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      styleHeaderRow(sheet, headers);
      return;
    }
    const existingCols = sheet.getLastColumn();
    if (existingCols < headers.length) {
      styleHeaderRow(sheet, headers);
    } else {
      const currentHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
      const mismatch = headers.some((h, idx) => String(currentHeaders[idx] || '').trim() !== h);
      if (mismatch) {
        styleHeaderRow(sheet, headers);
      }
    }
  });
}

/**
 * Setup Penuh: membuat & memformat ke-12 Sheet, Header, 2 Akun Bawaan, Akun Kas & Pengaturan Awal.
 */
function setupDatabaseOtomatis(customSpreadsheetId) {
  const ss = getTargetSpreadsheet(customSpreadsheetId);
  const now = nowWib();

  // 1. Buat & format seluruh 12 Sheet
  Object.keys(SHEET_SCHEMA).forEach((sheetName) => {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }
    styleHeaderRow(sheet, SHEET_SCHEMA[sheetName]);
  });

  // Hapus Sheet1 bawaan jika masih ada dan bukan bagian dari 12 sheet
  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) {
    try { ss.deleteSheet(defaultSheet); } catch (e) {}
  }

  // 2. Pastikan Sheet Karyawan berisi 2 Akun Bawaan (owner & kasir) jika kosong
  const shKaryawan = ss.getSheetByName('Karyawan');
  if (shKaryawan.getLastRow() <= 1) {
    const ownerAccess = JSON.stringify({
      menus: ['dashboard', 'penjualan', 'servis', 'stok', 'pembelian', 'pembayaran', 'kas', 'retur', 'laporan', 'karyawan', 'pengaturan'],
      lihat_modal: true, ubah_harga_diskon: true, lihat_laba: true, semua_transaksi: true,
      batal_retur_refund: true, cetak_ulang: true, ekspor_laporan: true, kelola_karyawan: true
    });
    const kasirAccess = JSON.stringify({
      menus: ['dashboard', 'penjualan', 'servis', 'stok', 'pembayaran'],
      lihat_modal: false, ubah_harga_diskon: false, lihat_laba: false, semua_transaksi: true,
      batal_retur_refund: false, cetak_ulang: true, ekspor_laporan: false, kelola_karyawan: false
    });
    const kRange = shKaryawan.getRange(2, 1, 2, SHEET_SCHEMA.Karyawan.length);
    shKaryawan.getRange(2, 6, 2, 1).setNumberFormat('@');
    kRange.setValues([
      ['USR-01', 'owner', '123', 'Pemilik Azi Cell', 'Pemilik', '081234567890', 'TRUE', 'FALSE', ownerAccess, now, now],
      ['USR-02', 'kasir', '123', 'Kasir Azi Cell', 'Kasir', '081299991111', 'TRUE', 'FALSE', kasirAccess, now, now]
    ]);
  }

  // 3. Pastikan Sheet Akun_Kas terisi 3 akun standar (saldo awal 0, siap produksi tanpa data dummy)
  const shAkun = ss.getSheetByName('Akun_Kas');
  if (shAkun.getLastRow() <= 1) {
    shAkun.getRange(2, 1, 3, SHEET_SCHEMA.Akun_Kas.length).setValues([
      ['ACC-TUNAI', 'Kas Tunai Laci', 'Tunai', 0, 0, 0, 0, 'TRUE', now],
      ['ACC-BANK', 'Bank BCA Operasional', 'Transfer', 0, 0, 0, 0, 'TRUE', now],
      ['ACC-QRIS', 'Saldo Penampungan QRIS', 'QRIS', 0, 0, 0, 0, 'TRUE', now]
    ]);
  }

  // 4. Pastikan Pengaturan Awal Terisi
  const shPengaturan = ss.getSheetByName('Pengaturan');
  if (shPengaturan.getLastRow() <= 1) {
    shPengaturan.getRange(2, 1, 8, SHEET_SCHEMA.Pengaturan.length).setValues([
      ['SPREADSHEET_ID_PEMILIK', ss.getId(), 'WAJIB GANTI KE ID SPREADSHEET PEMILIK SAAT SERAH TERIMA', 'owner', now],
      ['NAMA_TOKO', 'AZI CELL', 'Nama Toko pada Header Nota & Aplikasi', 'owner', now],
      ['TAGLINE_TOKO', 'Servis Hp Apple & Android — Software, Hardware & Aksesoris', 'Tagline pada Halaman Login & Header', 'owner', now],
      ['ALAMAT_TOKO', 'Jl. Pala Raya Sibata Mejasem Barat Kec. Kramat, Kode Pos 52181', 'Alamat Toko pada Struk Thermal', 'owner', now],
      ['KONTAK_TOKO', '08988522290', 'Nomor WA / Kontak Toko', 'owner', now],
      ['ZONA_WAKTU', 'Asia/Jakarta', 'Zona Waktu Operasional', 'owner', now],
      ['LEBAR_PRINTER', '58mm', 'Ukuran Kertas Printer Thermal (58mm / 80mm)', 'owner', now],
      ['FOOTER_NOTA', 'Terima kasih atas kepercayaan Anda di Azi Cell.\nBarang yang sudah dibeli tidak dapat ditukar kecuali ada perjanjian garansi.', 'Catatan Footer Struk Thermal', 'owner', now]
    ]);
  }

  return {
    status: 'OK',
    version: BACKEND_VERSION,
    spreadsheetId: ss.getId(),
    sheetsCount: Object.keys(SHEET_SCHEMA).length,
    updatedAt: now
  };
}

function writeTableRows(ss, sheetName, rowsArray) {
  if (!rowsArray || !Array.isArray(rowsArray)) return;
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  const headers = SHEET_SCHEMA[sheetName];
  const lastRow = sheet.getLastRow();
  const clearCols = Math.max(headers.length, sheet.getLastColumn());
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, clearCols).clearContent();
  }
  if (rowsArray.length > 0) {
    const sanitizedRows = rowsArray.map((row) =>
      row.map((cell) => (typeof cell === 'string' ? safeText(cell) : cell))
    );
    const textCols = TEXT_FORMAT_COLUMNS[sheetName] || [];
    textCols.forEach((colIdx) => {
      if (colIdx <= headers.length) {
        sheet.getRange(2, colIdx, sanitizedRows.length, 1).setNumberFormat('@');
      }
    });
    sheet.getRange(2, 1, sanitizedRows.length, headers.length).setValues(sanitizedRows);
  }
}

function syncFullPayloadToSheets(ss, db, audit) {
  const now = nowWib();
  const actor = (audit && audit.user) ? String(audit.user) : 'SYSTEM';

  // 1. Pengaturan
  if (db.config) {
    const c = db.config;
    const cfgRows = [
      ['SPREADSHEET_ID_PEMILIK', String(c.spreadsheetId || ss.getId()), 'ID Google Spreadsheet Pemilik Toko', actor, now],
      ['NAMA_TOKO', String(c.namaToko || 'AZI CELL'), 'Nama Toko pada Header Nota & Aplikasi', actor, now],
      ['TAGLINE_TOKO', String(c.tagline || ''), 'Tagline Toko', actor, now],
      ['ALAMAT_TOKO', String(c.alamat || ''), 'Alamat Toko pada Struk Thermal', actor, now],
      ['KONTAK_TOKO', String(c.kontak || ''), 'Nomor WA / Kontak Toko', actor, now],
      ['ZONA_WAKTU', String(c.zonaWaktu || 'Asia/Jakarta'), 'Zona Waktu Operasional', actor, now],
      ['LEBAR_PRINTER', String(c.lebarPrinter || '58mm'), 'Ukuran Kertas Printer Thermal (58mm / 80mm)', actor, now],
      ['FOOTER_NOTA', String(c.footerNota || ''), 'Catatan Footer Struk Thermal', actor, now]
    ];
    writeTableRows(ss, 'Pengaturan', cfgRows);
  }

  // 2. Karyawan
  if (Array.isArray(db.karyawan)) {
    const rows = db.karyawan.map((u) => [
      String(u.id || ''),
      String(u.username || ''),
      String(u.password || ''),
      String(u.nama || ''),
      String(u.jabatan || ''),
      String(u.kontak || '-'),
      u.aktif ? 'TRUE' : 'FALSE',
      u.wajibGantiPassword ? 'TRUE' : 'FALSE',
      JSON.stringify(u.akses || {}),
      String(u.dibuatPada || now),
      now
    ]);
    writeTableRows(ss, 'Karyawan', rows);
  }

  // 3. Akun_Kas (dihitung langsung dari saldoAwal + kasModal agar selalu akurat)
  if (Array.isArray(db.akunKas)) {
    const kasList = Array.isArray(db.kasModal) ? db.kasModal : [];
    const rows = db.akunKas.map((acc) => {
      let masuk = 0;
      let keluar = 0;
      kasList.forEach((k) => {
        const nom = safeNum(k.nominal, 0);
        if (k.jenis === 'Masuk' && k.akunTujuan === acc.id) masuk += nom;
        else if (k.jenis === 'Keluar' && k.akunAsal === acc.id) keluar += nom;
        else if (k.jenis === 'Transfer') {
          if (k.akunAsal === acc.id) keluar += nom;
          if (k.akunTujuan === acc.id) masuk += nom;
        }
      });
      const awal = safeNum(acc.saldoAwal, 0);
      const akhir = awal + masuk - keluar;
      return [
        String(acc.id || ''),
        String(acc.nama || ''),
        String(acc.tipe || 'Tunai'),
        awal,
        masuk,
        keluar,
        akhir,
        acc.aktif === false ? 'FALSE' : 'TRUE',
        now
      ];
    });
    writeTableRows(ss, 'Akun_Kas', rows);
  }

  // 4. Barang_Stok
  if (Array.isArray(db.barang)) {
    const rows = db.barang.map((b) => {
      const awal = safeNum(b.stokAwal, 0);
      const masuk = safeNum(b.masuk, 0);
      const keluar = safeNum(b.keluar, 0);
      const akhir = awal + masuk - keluar;
      return [
        String(b.sku || ''),
        String(b.barcode || '-'),
        String(b.nama || ''),
        String(b.kategori || ''),
        String(b.satuan || 'pcs'),
        safeNum(b.hargaModal, 0),
        safeNum(b.hargaJual, 0),
        awal,
        masuk,
        keluar,
        akhir,
        safeNum(b.stokMinimum, 0),
        String(b.pemasok || '-'),
        b.aktif === false ? 'FALSE' : 'TRUE',
        String(b.catatan || ''),
        now
      ];
    });
    writeTableRows(ss, 'Barang_Stok', rows);
  }

  // 5. Riwayat_Stok
  if (Array.isArray(db.riwayatStok)) {
    const rows = db.riwayatStok.map((m) => [
      String(m.id || ''),
      String(m.waktu || now),
      String(m.sku || ''),
      String(m.nama || ''),
      String(m.jenis || ''),
      String(m.ref || '-'),
      safeNum(m.masuk, 0),
      safeNum(m.keluar, 0),
      safeNum(m.sebelum, 0),
      safeNum(m.sesudah, 0),
      safeNum(m.modalSatuan, 0),
      String(m.alasan || ''),
      String(m.petugas || '-')
    ]);
    writeTableRows(ss, 'Riwayat_Stok', rows);
  }

  // 6. Pembelian
  if (Array.isArray(db.pembelian)) {
    const rows = db.pembelian.map((pb) => [
      String(pb.no || ''),
      String(pb.tanggal || ''),
      String(pb.pemasok || ''),
      String(pb.refNota || '-'),
      JSON.stringify(pb.items || []),
      safeNum(pb.total, 0),
      safeNum(pb.dibayar, 0),
      safeNum(pb.sisaUtang, 0),
      String(pb.statusBayar || ''),
      String(pb.akunId || ''),
      String(pb.jatuhTempo || ''),
      String(pb.petugas || '-'),
      String(pb.catatan || '')
    ]);
    writeTableRows(ss, 'Pembelian', rows);
  }

  // 7. Penjualan (mendukung Barang + Jasa Pasang seperti Beli LCD + Jasa Pasang)
  if (Array.isArray(db.penjualan)) {
    const rows = db.penjualan.map((p) => {
      const jasaItems = Array.isArray(p.jasaItems) ? p.jasaItems : [];
      const totalJasa = p.totalJasa !== undefined
        ? safeNum(p.totalJasa, 0)
        : jasaItems.reduce((sum, j) => sum + safeNum(j.biaya, 0), 0);
      return [
        String(p.no || ''),
        String(p.tanggalJam || ''),
        String(p.statusDokumen || 'Final'),
        String(p.pelanggan || 'Pelanggan Umum'),
        String(p.kontak || '-'),
        JSON.stringify(p.items || []),
        JSON.stringify(jasaItems),
        totalJasa,
        safeNum(p.subtotal, 0),
        safeNum(p.diskon, 0),
        safeNum(p.totalAkhir, 0),
        safeNum(p.totalModalHistoris, 0),
        safeNum(p.labaKotor, 0),
        String(p.metodeBayar || 'Tunai'),
        String(p.akunId || ''),
        safeNum(p.uangDiterima, 0),
        safeNum(p.kembalian, 0),
        safeNum(p.jumlahTerbayar, 0),
        safeNum(p.sisaPiutang, 0),
        String(p.statusBayar || 'Lunas'),
        String(p.jatuhTempo || ''),
        String(p.petugas || '-'),
        String(p.catatan || '')
      ];
    });
    writeTableRows(ss, 'Penjualan', rows);
  }

  // 8. Servis
  if (Array.isArray(db.servis)) {
    const rows = db.servis.map((s) => {
      const jasaItems = Array.isArray(s.jasaItems)
        ? s.jasaItems
        : (s.namaJasa ? [{ nama: s.namaJasa, biaya: safeNum(s.biayaJasa, 0) }] : []);
      return [
        String(s.no || ''),
        String(s.tanggalTerima || ''),
        String(s.tanggalSelesai || ''),
        String(s.tanggalDiambil || ''),
        String(s.pelanggan || ''),
        String(s.kontak || '-'),
        String(s.perangkat || ''),
        String(s.merekModel || ''),
        String(s.keluhan || ''),
        String(s.jenisServis || ''),
        String(s.kelengkapan || '-'),
        String(s.statusPengerjaan || 'Diterima'),
        String(s.tindakan || ''),
        JSON.stringify(s.spareparts || []),
        safeNum(s.totalSparepart, 0),
        safeNum(s.totalModalPart, 0),
        String(s.namaJasa || ''),
        (s.biayaJasa === null || s.biayaJasa === undefined || s.biayaJasa === '') ? '' : safeNum(s.biayaJasa, 0),
        JSON.stringify(jasaItems),
        safeNum(s.diskon, 0),
        safeNum(s.estimasiBiaya, 0),
        safeNum(s.totalBiayaFinal, 0),
        safeNum(s.dpAwal, 0),
        safeNum(s.totalTerbayar, 0),
        safeNum(s.sisaTagihan, 0),
        String(s.statusBayar || 'Belum Bayar'),
        s.stokPartTerpotong ? 'TRUE' : 'FALSE',
        String(s.alasanBatal || ''),
        String(s.teknisi || '-'),
        String(s.petugasTerima || '-')
      ];
    });
    writeTableRows(ss, 'Servis', rows);
  }

  // 9. Pembayaran_Tagihan
  if (Array.isArray(db.pembayaranTagihan)) {
    const rows = db.pembayaranTagihan.map((pay) => [
      String(pay.id || ''),
      String(pay.tanggalJam || now),
      String(pay.jenis || ''),
      String(pay.noRef || ''),
      String(pay.pihak || '-'),
      safeNum(pay.totalAwal, 0),
      safeNum(pay.sudahDibayar, 0),
      safeNum(pay.nominal, 0),
      safeNum(pay.sisaAkhir, 0),
      String(pay.metode || 'Tunai'),
      String(pay.akunId || ''),
      String(pay.refTransfer || ''),
      String(pay.statusKonfirmasi || 'Terkonfirmasi'),
      String(pay.petugas || '-'),
      String(pay.catatan || '')
    ]);
    writeTableRows(ss, 'Pembayaran_Tagihan', rows);
  }

  // 10. Kas_Modal
  if (Array.isArray(db.kasModal)) {
    const rows = db.kasModal.map((k) => [
      String(k.id || ''),
      String(k.tanggalJam || now),
      String(k.jenis || ''),
      String(k.kategori || ''),
      String(k.akunAsal || ''),
      String(k.akunTujuan || ''),
      safeNum(k.nominal, 0),
      String(k.noRef || ''),
      String(k.keterangan || ''),
      String(k.buktiUrl || ''),
      String(k.petugas || '-')
    ]);
    writeTableRows(ss, 'Kas_Modal', rows);
  }

  // 11. Retur_Koreksi
  if (Array.isArray(db.returKoreksi)) {
    const rows = db.returKoreksi.map((r) => [
      String(r.id || ''),
      String(r.tanggalJam || now),
      String(r.jenis || ''),
      String(r.noAsal || ''),
      JSON.stringify([{ sku: r.sku || '', nama: r.namaBarang || '', qty: safeNum(r.qty, 1) }]),
      r.layak ? 'Layak Jual' : 'Rusak',
      r.layak ? 'TRUE' : 'FALSE',
      safeNum(r.nilaiOmzet, 0),
      safeNum(r.nilaiModal, 0),
      String(r.metodePenyelesaian || 'Refund Kas'),
      safeNum(r.nominalPenyelesaian !== undefined ? r.nominalPenyelesaian : r.nilaiOmzet, 0),
      String(r.akunId || ''),
      String(r.alasan || ''),
      String(r.petugas || '-')
    ]);
    writeTableRows(ss, 'Retur_Koreksi', rows);
  }

  // 12. Log_Audit (sinkronkan log baru tanpa menimpa riwayat historis)
  const shLog = ss.getSheetByName('Log_Audit');
  if (shLog) {
    if (shLog.getLastRow() <= 1 && Array.isArray(db.logAudit) && db.logAudit.length > 0) {
      const logRows = db.logAudit.slice(0, 200).reverse().map((lg) => [
        String(lg.id || ''),
        String(lg.waktu || now),
        String(lg.pelaku || 'SYSTEM'),
        String(lg.aksi || ''),
        String(lg.target || '-'),
        String(lg.detail || ''),
        'PWA-CLIENT'
      ]);
      writeTableRows(ss, 'Log_Audit', logRows);
    } else if (audit && audit.action) {
      shLog.appendRow([
        'LOG-' + new Date().getTime().toString().slice(-6),
        safeText(audit.time || now),
        safeText(actor),
        safeText(audit.action || ''),
        safeText(audit.target || '-'),
        safeText(audit.detail || ''),
        'PWA-CLIENT'
      ]);
    }
  }
}

/**
 * Membaca seluruh 12 Sheet dari Spreadsheet untuk fitur Tarik Data (Pull Sync) ke perangkat baru.
 */
function readTableObjects(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastCol <= 0) return [];
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map((h) => String(h || '').trim());
  const result = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const hasContent = row.some((cell) => cell !== '' && cell !== null && cell !== undefined);
    if (!hasContent) continue;
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = row[idx];
    });
    result.push(obj);
  }
  return result;
}

function pullDatabaseFromSheets(ss) {
  const cfgRows = readTableObjects(ss, 'Pengaturan');
  const cfgMap = {};
  cfgRows.forEach((r) => {
    if (r.Kunci) cfgMap[String(r.Kunci).trim()] = String(r.Nilai !== undefined ? r.Nilai : '');
  });

  const config = {
    spreadsheetId: cfgMap.SPREADSHEET_ID_PEMILIK || ss.getId(),
    namaToko: cfgMap.NAMA_TOKO || 'AZI CELL',
    tagline: cfgMap.TAGLINE_TOKO || 'Pusat Penjualan Gadget, Aksesoris & Servis Profesional',
    alamat: cfgMap.ALAMAT_TOKO || 'Jl. Raya Utama No. 1, Pusat Kota',
    kontak: cfgMap.KONTAK_TOKO || '0812-3456-7890',
    zonaWaktu: cfgMap.ZONA_WAKTU || 'Asia/Jakarta',
    lebarPrinter: cfgMap.LEBAR_PRINTER || '58mm',
    footerNota: cfgMap.FOOTER_NOTA || 'Terima kasih atas kepercayaan Anda di Azi Cell.'
  };

  const karyawan = readTableObjects(ss, 'Karyawan').map((r) => ({
    id: String(r.ID_Karyawan || ''),
    username: String(r.Username || ''),
    password: String(r.Password_Hash || '123'),
    nama: String(r.Nama_Lengkap || ''),
    jabatan: String(r.Jabatan || 'Kasir'),
    kontak: String(r.Kontak || '-'),
    aktif: String(r.Status_Aktif).toUpperCase() !== 'FALSE',
    wajibGantiPassword: String(r.Wajib_Ganti_Password).toUpperCase() === 'TRUE',
    akses: safeJsonParse(r.Hak_Akses_JSON, { menus: ['dashboard'] }),
    dibuatPada: String(r.Dibuat_Pada || '')
  }));

  const akunKas = readTableObjects(ss, 'Akun_Kas').map((r) => ({
    id: String(r.ID_Akun || ''),
    nama: String(r.Nama_Akun || ''),
    tipe: String(r.Tipe_Akun || 'Tunai'),
    saldoAwal: safeNum(r.Saldo_Awal, 0),
    aktif: String(r.Status_Aktif).toUpperCase() !== 'FALSE'
  }));

  const barang = readTableObjects(ss, 'Barang_Stok').map((r) => ({
    sku: String(r.Kode_SKU || ''),
    barcode: String(r.Barcode || '-'),
    nama: String(r.Nama_Barang || ''),
    kategori: String(r.Kategori || ''),
    satuan: String(r.Satuan || 'pcs'),
    hargaModal: safeNum(r.Harga_Modal, 0),
    hargaJual: safeNum(r.Harga_Jual, 0),
    stokAwal: safeNum(r.Stok_Awal, 0),
    masuk: safeNum(r.Unit_Masuk, 0),
    keluar: safeNum(r.Unit_Keluar, 0),
    stokMinimum: safeNum(r.Stok_Minimum, 0),
    pemasok: String(r.Pemasok || '-'),
    aktif: String(r.Status_Aktif).toUpperCase() !== 'FALSE',
    catatan: String(r.Catatan || '')
  }));

  const riwayatStok = readTableObjects(ss, 'Riwayat_Stok').map((r) => ({
    id: String(r.ID_Mutasi || ''),
    waktu: String(r.Waktu || ''),
    sku: String(r.Kode_SKU || ''),
    nama: String(r.Nama_Barang || ''),
    jenis: String(r.Jenis_Gerakan || ''),
    ref: String(r.Sumber_Referensi || ''),
    masuk: safeNum(r.Jumlah_Masuk, 0),
    keluar: safeNum(r.Jumlah_Keluar, 0),
    sebelum: safeNum(r.Stok_Sebelum, 0),
    sesudah: safeNum(r.Stok_Sesudah, 0),
    modalSatuan: safeNum(r.Harga_Modal_Satuan, 0),
    alasan: String(r.Alasan_Catatan || ''),
    petugas: String(r.Petugas || '-')
  }));

  const pembelian = readTableObjects(ss, 'Pembelian').map((r) => ({
    no: String(r.No_Pembelian || ''),
    tanggal: String(r.Tanggal || ''),
    pemasok: String(r.Nama_Pemasok || ''),
    refNota: String(r.No_Referensi_Nota || ''),
    items: safeJsonParse(r.Item_JSON, []),
    total: safeNum(r.Total_Pembelian, 0),
    dibayar: safeNum(r.Jumlah_Dibayar, 0),
    sisaUtang: safeNum(r.Sisa_Utang, 0),
    statusBayar: String(r.Status_Bayar || 'Lunas'),
    akunId: String(r.ID_Akun_Kas || 'ACC-TUNAI'),
    jatuhTempo: String(r.Jatuh_Tempo || ''),
    petugas: String(r.Petugas || '-'),
    catatan: String(r.Catatan || '')
  }));

  const penjualan = readTableObjects(ss, 'Penjualan').map((r) => {
    const jasaItems = safeJsonParse(r.Jasa_JSON, []);
    const totalJasa = r.Total_Jasa !== undefined && r.Total_Jasa !== ''
      ? safeNum(r.Total_Jasa, 0)
      : jasaItems.reduce((sum, j) => sum + safeNum(j.biaya, 0), 0);
    return {
      no: String(r.No_Transaksi || ''),
      tanggalJam: String(r.Tanggal_Jam || ''),
      statusDokumen: String(r.Status_Dokumen || 'Final'),
      pelanggan: String(r.Nama_Pelanggan || 'Pelanggan Umum'),
      kontak: String(r.Kontak_Pelanggan || '-'),
      items: safeJsonParse(r.Item_JSON, []),
      jasaItems: jasaItems,
      totalJasa: totalJasa,
      subtotal: safeNum(r.Subtotal, 0),
      diskon: safeNum(r.Diskon, 0),
      totalAkhir: safeNum(r.Total_Akhir, 0),
      totalModalHistoris: safeNum(r.Total_Modal_Historis, 0),
      labaKotor: safeNum(r.Laba_Kotor, 0),
      metodeBayar: String(r.Metode_Bayar || 'Tunai'),
      akunId: String(r.ID_Akun_Kas || 'ACC-TUNAI'),
      uangDiterima: safeNum(r.Uang_Diterima, 0),
      kembalian: safeNum(r.Kembalian, 0),
      jumlahTerbayar: safeNum(r.Jumlah_Terbayar, 0),
      sisaPiutang: safeNum(r.Sisa_Piutang, 0),
      statusBayar: String(r.Status_Bayar || 'Lunas'),
      jatuhTempo: String(r.Jatuh_Tempo || ''),
      petugas: String(r.Petugas || '-'),
      catatan: String(r.Catatan || '')
    };
  });

  const servis = readTableObjects(ss, 'Servis').map((r) => {
    const jasaItems = safeJsonParse(r.Jasa_JSON, []);
    const namaJasa = String(r.Nama_Jasa || '');
    const biayaJasa = r.Biaya_Jasa === '' ? 0 : safeNum(r.Biaya_Jasa, 0);
    return {
      no: String(r.No_Servis || ''),
      tanggalTerima: String(r.Tanggal_Terima || ''),
      tanggalSelesai: String(r.Tanggal_Selesai || ''),
      tanggalDiambil: String(r.Tanggal_Diambil || ''),
      pelanggan: String(r.Nama_Pelanggan || ''),
      kontak: String(r.Kontak_Pelanggan || '-'),
      perangkat: String(r.Perangkat_Barang || ''),
      merekModel: String(r.Merek_Model || ''),
      keluhan: String(r.Keluhan || ''),
      jenisServis: String(r.Jenis_Servis || ''),
      kelengkapan: String(r.Kondisi_Kelengkapan || '-'),
      statusPengerjaan: String(r.Status_Pengerjaan || 'Diterima'),
      tindakan: String(r.Tindakan_Teknisi || ''),
      spareparts: safeJsonParse(r.Sparepart_JSON, []),
      totalSparepart: safeNum(r.Total_Sparepart, 0),
      totalModalPart: safeNum(r.Total_Modal_Part, 0),
      namaJasa: namaJasa,
      biayaJasa: biayaJasa,
      jasaItems: jasaItems.length ? jasaItems : (namaJasa ? [{ nama: namaJasa, biaya: biayaJasa }] : []),
      diskon: safeNum(r.Diskon, 0),
      estimasiBiaya: safeNum(r.Estimasi_Biaya, 0),
      totalBiayaFinal: safeNum(r.Total_Biaya_Final, 0),
      dpAwal: safeNum(r.DP_Awal, 0),
      totalTerbayar: safeNum(r.Total_Terbayar, 0),
      sisaTagihan: safeNum(r.Sisa_Tagihan, 0),
      statusBayar: String(r.Status_Bayar || 'Belum Bayar'),
      stokPartTerpotong: String(r.Stok_Part_Terpotong).toUpperCase() === 'TRUE',
      alasanBatal: String(r.Alasan_Batal || ''),
      teknisi: String(r.Teknisi || '-'),
      petugasTerima: String(r.Petugas_Terima || '-')
    };
  });

  const pembayaranTagihan = readTableObjects(ss, 'Pembayaran_Tagihan').map((r) => ({
    id: String(r.ID_Pembayaran || ''),
    tanggalJam: String(r.Tanggal_Jam || ''),
    jenis: String(r.Jenis_Tagihan || ''),
    noRef: String(r.No_Referensi || ''),
    pihak: String(r.Pihak_Terkait || '-'),
    totalAwal: safeNum(r.Total_Tagihan_Awal, 0),
    sudahDibayar: safeNum(r.Sudah_Dibayar_Sebelumnya, 0),
    nominal: safeNum(r.Nominal_Bayar, 0),
    sisaAkhir: safeNum(r.Sisa_Tagihan_Akhir, 0),
    metode: String(r.Metode_Bayar || 'Tunai'),
    akunId: String(r.ID_Akun_Kas || 'ACC-TUNAI'),
    refTransfer: String(r.Ref_Transfer_QRIS || ''),
    statusKonfirmasi: String(r.Status_Konfirmasi || 'Terkonfirmasi'),
    petugas: String(r.Petugas || '-'),
    catatan: String(r.Catatan || '')
  }));

  const kasModal = readTableObjects(ss, 'Kas_Modal').map((r) => ({
    id: String(r.ID_Kas || ''),
    tanggalJam: String(r.Tanggal_Jam || ''),
    jenis: String(r.Jenis_Arus || ''),
    kategori: String(r.Kategori || ''),
    akunAsal: String(r.ID_Akun_Asal || ''),
    akunTujuan: String(r.ID_Akun_Tujuan || ''),
    nominal: safeNum(r.Nominal, 0),
    noRef: String(r.No_Referensi || ''),
    keterangan: String(r.Keterangan || ''),
    buktiUrl: String(r.Bukti_URL || ''),
    petugas: String(r.Petugas || '-')
  }));

  const returKoreksi = readTableObjects(ss, 'Retur_Koreksi').map((r) => {
    const items = safeJsonParse(r.Item_JSON, []);
    const first = items[0] || {};
    return {
      id: String(r.ID_Retur || ''),
      tanggalJam: String(r.Tanggal_Jam || ''),
      jenis: String(r.Jenis_Koreksi || ''),
      noAsal: String(r.No_Transaksi_Asal || ''),
      sku: String(first.sku || ''),
      namaBarang: String(first.nama || ''),
      qty: safeNum(first.qty, 1),
      layak: String(r.Kembali_Ke_Stok).toUpperCase() === 'TRUE',
      nilaiOmzet: safeNum(r.Nilai_Koreksi_Omzet, 0),
      nilaiModal: safeNum(r.Nilai_Koreksi_Modal, 0),
      metodePenyelesaian: String(r.Metode_Penyelesaian_Dana || 'Refund Kas'),
      nominalPenyelesaian: safeNum(r.Nominal_Refund_Potong_Tagihan, 0),
      akunId: String(r.ID_Akun_Kas || ''),
      alasan: String(r.Alasan || ''),
      petugas: String(r.Petugas || '-')
    };
  });

  const logAudit = readTableObjects(ss, 'Log_Audit').map((r) => ({
    id: String(r.ID_Log || ''),
    waktu: String(r.Waktu || ''),
    pelaku: String(r.Username_Pelaku || 'SYSTEM'),
    aksi: String(r.Aksi || ''),
    target: String(r.Target_Objek || '-'),
    detail: String(r.Detail_Perubahan || '')
  })).reverse();

  return {
    config,
    karyawan,
    akunKas,
    barang,
    riwayatStok,
    pembelian,
    penjualan,
    servis,
    pembayaranTagihan,
    kasModal,
    returKoreksi,
    logAudit
  };
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = String(params.action || '').toLowerCase();
    const ss = getTargetSpreadsheet(params.spreadsheetId);

    if (action === 'pull') {
      ensureSchemaFast(ss);
      const data = pullDatabaseFromSheets(ss);
      return jsonOutput({
        status: 'PULL_SUCCESS',
        version: BACKEND_VERSION,
        spreadsheetId: ss.getId(),
        pulledAt: nowWib(),
        data: data
      });
    }

    if (action === 'setup') {
      const res = setupDatabaseOtomatis(params.spreadsheetId);
      return jsonOutput({
        status: 'SETUP_SUCCESS',
        app: 'AZI CELL PWA BACKEND',
        version: BACKEND_VERSION,
        setup: res
      });
    }

    ensureSchemaFast(ss);
    return jsonOutput({
      status: 'ONLINE',
      app: 'AZI CELL PWA BACKEND',
      version: BACKEND_VERSION,
      spreadsheetId: ss.getId(),
      sheetsCount: Object.keys(SHEET_SCHEMA).length,
      time: nowWib()
    });
  } catch (err) {
    return jsonOutput({ status: 'ERROR', message: err.toString() });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.tryLock(15000);
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const body = JSON.parse(raw);
    const ss = getTargetSpreadsheet(body.spreadsheetId);

    if (body.action === 'AUTO_SETUP_SHEETS') {
      setupDatabaseOtomatis(body.spreadsheetId);
    } else {
      ensureSchemaFast(ss);
    }

    if (body.payload) {
      syncFullPayloadToSheets(ss, body.payload, body.audit);
    }

    return jsonOutput({
      status: 'SYNC_SUCCESS',
      version: BACKEND_VERSION,
      spreadsheetId: ss.getId(),
      syncedAt: nowWib()
    });
  } catch (err) {
    return jsonOutput({ status: 'ERROR', message: err.toString() });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}
