/**
 * ============================================================================
 * KONFIGURASI UTAMA AZI CELL PWA
 * ============================================================================
 * ⚠️ PERHATIAN PENTING SAAT SERAH TERIMA KE PEMILIK APLIKASI (WAJIB DIGANTI):
 * 1. Ganti SPREADSHEET_ID dan SPREADSHEET_URL di bawah ini dengan link Google
 *    Spreadsheet milik pemilik toko yang baru.
 * 2. Pasang file Code.gs di Google Apps Script milik pemilik, klik Deploy >
 *    New Deployment (Web App - Anyone), lalu tempel URL-nya ke GAS_WEB_APP_URL.
 * 3. Setiap kali Anda melakukan revisi kodingan dan push ke GitHub, naikkan
 *    angka APP_VERSION (dan CACHE_VERSION di sw.js) agar HP/PC pengguna otomatis
 *    menampilkan animasi Loading Muter & memperbarui aplikasi ke versi terbaru!
 * ============================================================================
 */
window.AZI_CONFIG = {
  // Naikkan versi ini setiap kali update agar sinkron dengan sw.js
  APP_VERSION: "1.0.5",

  // ==========================================================================
  // [WAJIB GANTI KE PEMILIK APLIKASI SAAT HANDOVER / SERAH TERIMA]
  // ==========================================================================
  SPREADSHEET_ID: "1WH_nBZ7vsXp2lurFDKZV7TL1pqnrfLD27cax85m4-d8",
  SPREADSHEET_URL: "https://docs.google.com/spreadsheets/d/1WH_nBZ7vsXp2lurFDKZV7TL1pqnrfLD27cax85m4-d8/edit?usp=sharing",
  GAS_WEB_APP_URL: "https://script.google.com/macros/s/AKfycbyANSh8ij_QGSSLunF_fGQsNzl9n6g4Iy-S0ZVXLAygJJz8X4gxzSzJR5OPDQRvHprYgw/exec",

  // Profil Default Toko (Dapat diubah langsung oleh Pemilik di menu Pengaturan)
  STORE_PROFILE: {
    namaToko: "AZI CELL",
    tagline: "Pusat Penjualan Gadget, Aksesoris & Servis Profesional",
    alamat: "Jl. Raya Utama No. 1, Pusat Kota",
    kontak: "0812-3456-7890",
    mataUang: "IDR",
    zonaWaktu: "Asia/Jakarta",
    logoUrl: "logo1.png",
    lebarPrinter: "58mm",
    footerNota: "Terima kasih atas kepercayaan Anda di Azi Cell.\nBarang yang sudah dibeli tidak dapat ditukar kecuali ada perjanjian garansi."
  },

  // Daftar 12 Sheet Otomatis & Kolom Header Standar Azi Cell (Sinkron 100% dengan Code.gs)
  SHEET_SCHEMA: {
    Pengaturan: ["Kunci", "Nilai", "Keterangan", "Diperbarui_Oleh", "Waktu_Update"],
    Karyawan: ["ID_Karyawan", "Username", "Password_Hash", "Nama_Lengkap", "Jabatan", "Kontak", "Status_Aktif", "Wajib_Ganti_Password", "Hak_Akses_JSON", "Dibuat_Pada", "Diperbarui_Pada"],
    Akun_Kas: ["ID_Akun", "Nama_Akun", "Tipe_Akun", "Saldo_Awal", "Total_Masuk", "Total_Keluar", "Saldo_Akhir", "Status_Aktif", "Diperbarui_Pada"],
    Barang_Stok: ["Kode_SKU", "Barcode", "Nama_Barang", "Kategori", "Satuan", "Harga_Modal", "Harga_Jual", "Stok_Awal", "Unit_Masuk", "Unit_Keluar", "Stok_Akhir", "Stok_Minimum", "Pemasok", "Status_Aktif", "Catatan", "Diperbarui_Pada"],
    Riwayat_Stok: ["ID_Mutasi", "Waktu", "Kode_SKU", "Nama_Barang", "Jenis_Gerakan", "Sumber_Referensi", "Jumlah_Masuk", "Jumlah_Keluar", "Stok_Sebelum", "Stok_Sesudah", "Harga_Modal_Satuan", "Alasan_Catatan", "Petugas"],
    Pembelian: ["No_Pembelian", "Tanggal", "Nama_Pemasok", "No_Referensi_Nota", "Item_JSON", "Total_Pembelian", "Jumlah_Dibayar", "Sisa_Utang", "Status_Bayar", "ID_Akun_Kas", "Jatuh_Tempo", "Petugas", "Catatan"],
    Penjualan: ["No_Transaksi", "Tanggal_Jam", "Status_Dokumen", "Nama_Pelanggan", "Kontak_Pelanggan", "Item_JSON", "Jasa_JSON", "Total_Jasa", "Subtotal", "Diskon", "Total_Akhir", "Total_Modal_Historis", "Laba_Kotor", "Metode_Bayar", "ID_Akun_Kas", "Uang_Diterima", "Kembalian", "Jumlah_Terbayar", "Sisa_Piutang", "Status_Bayar", "Jatuh_Tempo", "Petugas", "Catatan"],
    Servis: ["No_Servis", "Tanggal_Terima", "Tanggal_Selesai", "Tanggal_Diambil", "Nama_Pelanggan", "Kontak_Pelanggan", "Perangkat_Barang", "Merek_Model", "Keluhan", "Jenis_Servis", "Kondisi_Kelengkapan", "Status_Pengerjaan", "Tindakan_Teknisi", "Sparepart_JSON", "Total_Sparepart", "Total_Modal_Part", "Nama_Jasa", "Biaya_Jasa", "Jasa_JSON", "Diskon", "Estimasi_Biaya", "Total_Biaya_Final", "DP_Awal", "Total_Terbayar", "Sisa_Tagihan", "Status_Bayar", "Stok_Part_Terpotong", "Alasan_Batal", "Teknisi", "Petugas_Terima"],
    Pembayaran_Tagihan: ["ID_Pembayaran", "Tanggal_Jam", "Jenis_Tagihan", "No_Referensi", "Pihak_Terkait", "Total_Tagihan_Awal", "Sudah_Dibayar_Sebelumnya", "Nominal_Bayar", "Sisa_Tagihan_Akhir", "Metode_Bayar", "ID_Akun_Kas", "Ref_Transfer_QRIS", "Status_Konfirmasi", "Petugas", "Catatan"],
    Kas_Modal: ["ID_Kas", "Tanggal_Jam", "Jenis_Arus", "Kategori", "ID_Akun_Asal", "ID_Akun_Tujuan", "Nominal", "No_Referensi", "Keterangan", "Bukti_URL", "Petugas"],
    Retur_Koreksi: ["ID_Retur", "Tanggal_Jam", "Jenis_Koreksi", "No_Transaksi_Asal", "Item_JSON", "Kondisi_Barang", "Kembali_Ke_Stok", "Nilai_Koreksi_Omzet", "Nilai_Koreksi_Modal", "Metode_Penyelesaian_Dana", "Nominal_Refund_Potong_Tagihan", "ID_Akun_Kas", "Alasan", "Petugas"],
    Log_Audit: ["ID_Log", "Waktu", "Username_Pelaku", "Aksi", "Target_Objek", "Detail_Perubahan", "IP_Perangkat"]
  }
};
