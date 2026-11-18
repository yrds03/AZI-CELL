/**
 * ============================================================================
 * AZI CELL - ENTERPRISE POS, SERVICE & ACCOUNTING PWA ENGINE (app.js)
 * Mengimplementasikan seluruh 16 Bab Alur Lengkap Aplikasi PWA Azi Cell
 * ============================================================================
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'AZICELL_DB_STATE_V1';
  const SESSION_KEY = 'AZICELL_ACTIVE_SESSION_V1';
  const VERSION_KEY = 'AZICELL_INSTALLED_VER';

  // Daftar UUID Service BLE Printer Thermal populer (58mm/80mm: RPP, Eppos, Panda, VSC, Xprinter, Goojprt, Zjiang, Blueprint)
  const BLE_PRINTER_SERVICES = [
    '000018f0-0000-1000-8000-00805f9b34fb',
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    '0000ff00-0000-1000-8000-00805f9b34fb',
    '0000ffe0-0000-1000-8000-00805f9b34fb',
    '0000ae30-0000-1000-8000-00805f9b34fb',
    '0000fee7-0000-1000-8000-00805f9b34fb'
  ];

  let deferredInstallPrompt = null;
  let bluetoothDevice = null;
  let bluetoothCharacteristic = null;
  let bluetoothStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
  let bluetoothDeviceName = '';
  let lastReceiptBlePayload = null;
  let isSubmittingLock = false;
  let isUpdatingOverlayActive = false;
  let idSeqCounter = 0;
  let cloudSyncState = { status: 'idle', lastSyncedAt: '', message: '' };

  // Hak Akses Standar per Profil (Bab 04 - selaras dengan Code.gs)
  const ROLE_PRESETS = {
    Pemilik: {
      menus: ['dashboard', 'penjualan', 'servis', 'stok', 'pembelian', 'pembayaran', 'kas', 'retur', 'laporan', 'karyawan', 'pengaturan'],
      lihat_modal: true,
      ubah_harga_diskon: true,
      lihat_laba: true,
      semua_transaksi: true,
      batal_retur_refund: true,
      cetak_ulang: true,
      ekspor_laporan: true,
      kelola_karyawan: true
    },
    Kasir: {
      menus: ['dashboard', 'penjualan', 'servis', 'stok', 'pembayaran'],
      lihat_modal: false,
      ubah_harga_diskon: false,
      lihat_laba: false,
      semua_transaksi: true,
      batal_retur_refund: false,
      cetak_ulang: true,
      ekspor_laporan: false,
      kelola_karyawan: false
    },
    Teknisi: {
      menus: ['dashboard', 'servis', 'stok'],
      lihat_modal: false,
      ubah_harga_diskon: false,
      lihat_laba: false,
      semua_transaksi: false,
      batal_retur_refund: false,
      cetak_ulang: true,
      ekspor_laporan: false,
      kelola_karyawan: false
    },
    Gudang: {
      menus: ['dashboard', 'stok', 'pembelian', 'retur'],
      lihat_modal: true,
      ubah_harga_diskon: false,
      lihat_laba: false,
      semua_transaksi: true,
      batal_retur_refund: false,
      cetak_ulang: false,
      ekspor_laporan: false,
      kelola_karyawan: false
    },
    Keuangan: {
      menus: ['dashboard', 'pembayaran', 'kas', 'pembelian', 'retur', 'laporan'],
      lihat_modal: true,
      ubah_harga_diskon: false,
      lihat_laba: true,
      semua_transaksi: true,
      batal_retur_refund: true,
      cetak_ulang: true,
      ekspor_laporan: true,
      kelola_karyawan: false
    }
  };

  function nowStr() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function todayStr() {
    return nowStr().slice(0, 10);
  }

  function genId(prefix) {
    idSeqCounter = (idSeqCounter + 1) % 1000;
    return `${prefix}-${Date.now().toString().slice(-6)}${String(idSeqCounter).padStart(3, '0')}`;
  }

  function nextSeqNo(prefix, list, key = 'no', padLen = 3) {
    let maxNum = 0;
    (list || []).forEach((item) => {
      const val = String(item[key] || '');
      const m = val.match(new RegExp(`^${prefix}-(\\d+)$`));
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    });
    return `${prefix}-${String(maxNum + 1).padStart(padLen, '0')}`;
  }

  function esc(val) {
    return String(val === null || val === undefined ? '' : val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Data Awal (Seed Data) sesuai Bab 15 & sinkron 2 akun bawaan Code.gs (owner & kasir)
  function createInitialDatabase() {
    const now = nowStr();
    const today = todayStr();
    return {
      config: {
        spreadsheetId: window.AZI_CONFIG.SPREADSHEET_ID,
        spreadsheetUrl: window.AZI_CONFIG.SPREADSHEET_URL,
        gasWebAppUrl: window.AZI_CONFIG.GAS_WEB_APP_URL || '',
        ...window.AZI_CONFIG.STORE_PROFILE
      },
      karyawan: [
        { id: 'USR-01', username: 'owner', password: '123', nama: 'Pemilik Azi Cell', jabatan: 'Pemilik', kontak: '081234567890', aktif: true, wajibGantiPassword: false, akses: JSON.parse(JSON.stringify(ROLE_PRESETS.Pemilik)), dibuatPada: now },
        { id: 'USR-02', username: 'kasir', password: '123', nama: 'Kasir Azi Cell', jabatan: 'Kasir', kontak: '081299991111', aktif: true, wajibGantiPassword: false, akses: JSON.parse(JSON.stringify(ROLE_PRESETS.Kasir)), dibuatPada: now }
      ],
      akunKas: [
        { id: 'ACC-TUNAI', nama: 'Kas Tunai Laci', tipe: 'Tunai', saldoAwal: 5000000, aktif: true },
        { id: 'ACC-BANK', nama: 'Bank BCA Operasional', tipe: 'Transfer', saldoAwal: 15000000, aktif: true },
        { id: 'ACC-QRIS', nama: 'Saldo Penampungan QRIS', tipe: 'QRIS', saldoAwal: 0, aktif: true }
      ],
      barang: [
        { sku: 'KBL-TC01', barcode: '899001', nama: 'Kabel Data Fast Charging Type-C', kategori: 'Aksesoris', satuan: 'pcs', hargaModal: 20000, hargaJual: 35000, stokAwal: 0, masuk: 10, keluar: 1, stokMinimum: 3, pemasok: 'Distributor Jaya', aktif: true, catatan: 'Contoh Bab 15' },
        { sku: 'PRT-LCD01', barcode: '899002', nama: 'LCD Touchscreen Ori Set', kategori: 'Spare Part', satuan: 'pcs', hargaModal: 55000, hargaJual: 80000, stokAwal: 5, masuk: 0, keluar: 1, stokMinimum: 2, pemasok: 'Mitra Sparepart', aktif: true, catatan: 'Sparepart / Bisa Jual + Pasang' },
        { sku: 'AKS-TG01', barcode: '899003', nama: 'Tempered Glass Ceramic Matte', kategori: 'Aksesoris', satuan: 'pcs', hargaModal: 8000, hargaJual: 25000, stokAwal: 20, masuk: 0, keluar: 0, stokMinimum: 5, pemasok: 'Distributor Jaya', aktif: true, catatan: '' },
        { sku: 'AKS-CHG20', barcode: '899004', nama: 'Charger Adapter 20W PD', kategori: 'Aksesoris', satuan: 'unit', hargaModal: 45000, hargaJual: 85000, stokAwal: 8, masuk: 0, keluar: 0, stokMinimum: 3, pemasok: 'Distributor Jaya', aktif: true, catatan: '' }
      ],
      riwayatStok: [
        { id: 'MUT-001', waktu: now, sku: 'KBL-TC01', nama: 'Kabel Data Fast Charging Type-C', jenis: 'Pembelian Masuk', ref: 'PB-001', masuk: 10, keluar: 0, sebelum: 0, sesudah: 10, modalSatuan: 20000, alasan: 'Kulakan lunas Bab 15', petugas: 'owner' },
        { id: 'MUT-002', waktu: now, sku: 'KBL-TC01', nama: 'Kabel Data Fast Charging Type-C', jenis: 'Penjualan', ref: 'PJ-001', masuk: 0, keluar: 1, sebelum: 10, sesudah: 9, modalSatuan: 20000, alasan: 'Penjualan kasir Bab 15', petugas: 'kasir' },
        { id: 'MUT-003', waktu: now, sku: 'PRT-LCD01', nama: 'LCD Touchscreen Ori Set', jenis: 'Pemakaian Servis', ref: 'SRV-001', masuk: 0, keluar: 1, sebelum: 5, sesudah: 4, modalSatuan: 55000, alasan: 'Servis Selesai SRV-001', petugas: 'owner' }
      ],
      pembelian: [
        { no: 'PB-001', tanggal: today, pemasok: 'Distributor Jaya', refNota: 'INV-DJ-88', items: [{ sku: 'KBL-TC01', nama: 'Kabel Data Fast Charging Type-C', qty: 10, satuan: 'pcs', hargaBeli: 20000 }], total: 200000, dibayar: 200000, sisaUtang: 0, statusBayar: 'Lunas', akunId: 'ACC-TUNAI', jatuhTempo: '', petugas: 'owner', catatan: 'Pembelian 10 kabel @Rp20.000 lunas' }
      ],
      penjualan: [
        { no: 'PJ-001', tanggalJam: now, statusDokumen: 'Final', pelanggan: 'Pelanggan Umum', kontak: '-', items: [{ sku: 'KBL-TC01', nama: 'Kabel Data Fast Charging Type-C', qty: 1, satuan: 'pcs', hargaJual: 35000, hargaModal: 20000 }], jasaItems: [], totalJasa: 0, subtotal: 35000, diskon: 0, totalAkhir: 35000, totalModalHistoris: 20000, labaKotor: 15000, metodeBayar: 'Tunai', akunId: 'ACC-TUNAI', uangDiterima: 50000, kembalian: 15000, jumlahTerbayar: 35000, sisaPiutang: 0, statusBayar: 'Lunas', jatuhTempo: '', petugas: 'kasir', catatan: 'Contoh Bab 15: Bayar Rp50.000 kembali Rp15.000' }
      ],
      servis: [
        { no: 'SRV-001', tanggalTerima: now, tanggalSelesai: now, tanggalDiambil: '', pelanggan: 'Bpk. Hendra', kontak: '081388887777', perangkat: 'Smartphone Android', merekModel: 'Redmi Note 10', keluhan: 'Layar pecah bergaris', jenisServis: 'Ganti LCD + Pasang', kelengkapan: 'Unit + Silikon', statusPengerjaan: 'Selesai', tindakan: 'Penggantian LCD set dan pembersihan soket', spareparts: [{ sku: 'PRT-LCD01', nama: 'LCD Touchscreen Ori Set', qty: 1, hargaJual: 80000, hargaModal: 55000, terpotong: true }], totalSparepart: 80000, totalModalPart: 55000, namaJasa: 'Jasa Pasang & Kalibrasi LCD', biayaJasa: 50000, jasaItems: [{ nama: 'Jasa Pasang & Kalibrasi LCD', biaya: 50000 }], diskon: 0, estimasiBiaya: 130000, totalBiayaFinal: 130000, dpAwal: 50000, totalTerbayar: 50000, sisaTagihan: 80000, statusBayar: 'DP/Sebagian', stokPartTerpotong: true, alasanBatal: '', teknisi: 'owner', petugasTerima: 'kasir' }
      ],
      pembayaranTagihan: [
        { id: 'PAY-001', tanggalJam: now, jenis: 'DP Servis', noRef: 'SRV-001', pihak: 'Bpk. Hendra', totalAwal: 130000, sudahDibayar: 0, nominal: 50000, sisaAkhir: 80000, metode: 'Tunai', akunId: 'ACC-TUNAI', refTransfer: '', statusKonfirmasi: 'Terkonfirmasi', petugas: 'kasir', catatan: 'DP awal saat terima servis (Uang masuk, bukan omzet ganda)' }
      ],
      kasModal: [
        { id: 'KAS-001', tanggalJam: now, jenis: 'Keluar', kategori: 'Pembelian Stok Pemasok', akunAsal: 'ACC-TUNAI', akunTujuan: '', nominal: 200000, noRef: 'PB-001', keterangan: 'Bayar kulakan 10 kabel data', petugas: 'owner' },
        { id: 'KAS-002', tanggalJam: now, jenis: 'Masuk', kategori: 'Penjualan Barang', akunAsal: '', akunTujuan: 'ACC-TUNAI', nominal: 35000, noRef: 'PJ-001', keterangan: 'Penjualan 1 kabel data (Tunai Rp50rb kembali Rp15rb)', petugas: 'kasir' },
        { id: 'KAS-003', tanggalJam: now, jenis: 'Masuk', kategori: 'DP / Pembayaran Servis', akunAsal: '', akunTujuan: 'ACC-TUNAI', nominal: 50000, noRef: 'SRV-001', keterangan: 'DP Servis SRV-001 Bpk. Hendra', petugas: 'kasir' }
      ],
      returKoreksi: [],
      logAudit: [
        { id: 'LOG-001', waktu: now, pelaku: 'SYSTEM', aksi: 'INIT_DB', target: '12_SHEETS', detail: 'Inisialisasi struktur 12 sheet & seed data Azi Cell' }
      ]
    };
  }

  function migrateDatabase(parsed) {
    const base = createInitialDatabase();
    const incomingCfg = parsed.config || {};
    const mergedCfg = { ...base.config, ...incomingCfg };
    // Pastikan perangkat lama yang belum punya GAS_WEB_APP_URL otomatis mewarisi URL dari config.js
    if (!mergedCfg.gasWebAppUrl && window.AZI_CONFIG.GAS_WEB_APP_URL) {
      mergedCfg.gasWebAppUrl = window.AZI_CONFIG.GAS_WEB_APP_URL;
    }
    if (!mergedCfg.spreadsheetId && window.AZI_CONFIG.SPREADSHEET_ID) {
      mergedCfg.spreadsheetId = window.AZI_CONFIG.SPREADSHEET_ID;
    }
    if (!mergedCfg.spreadsheetUrl && window.AZI_CONFIG.SPREADSHEET_URL) {
      mergedCfg.spreadsheetUrl = window.AZI_CONFIG.SPREADSHEET_URL;
    }
    const merged = {
      config: mergedCfg,
      karyawan: Array.isArray(parsed.karyawan) && parsed.karyawan.length ? parsed.karyawan : base.karyawan,
      akunKas: Array.isArray(parsed.akunKas) && parsed.akunKas.length ? parsed.akunKas : base.akunKas,
      barang: Array.isArray(parsed.barang) ? parsed.barang : base.barang,
      riwayatStok: Array.isArray(parsed.riwayatStok) ? parsed.riwayatStok : [],
      pembelian: Array.isArray(parsed.pembelian) ? parsed.pembelian : [],
      penjualan: Array.isArray(parsed.penjualan) ? parsed.penjualan : [],
      servis: Array.isArray(parsed.servis) ? parsed.servis : [],
      pembayaranTagihan: Array.isArray(parsed.pembayaranTagihan) ? parsed.pembayaranTagihan : [],
      kasModal: Array.isArray(parsed.kasModal) ? parsed.kasModal : [],
      returKoreksi: Array.isArray(parsed.returKoreksi) ? parsed.returKoreksi : [],
      logAudit: Array.isArray(parsed.logAudit) ? parsed.logAudit : []
    };

    // Normalisasi struktur penjualan lama agar kompatibel dengan Jasa Pasang POS
    merged.penjualan.forEach((p) => {
      if (!Array.isArray(p.items)) p.items = [];
      if (!Array.isArray(p.jasaItems)) p.jasaItems = [];
      if (p.totalJasa === undefined) {
        p.totalJasa = p.jasaItems.reduce((s, j) => s + (Number(j.biaya) || 0), 0);
      }
    });

    // Normalisasi struktur servis lama agar kompatibel dengan multi-jasa & pelacakan potong stok per part
    merged.servis.forEach((s) => {
      if (!Array.isArray(s.spareparts)) s.spareparts = [];
      s.spareparts.forEach((sp) => {
        if (sp.terpotong === undefined) sp.terpotong = Boolean(s.stokPartTerpotong);
      });
      if (!Array.isArray(s.jasaItems)) {
        s.jasaItems = s.namaJasa ? [{ nama: s.namaJasa, biaya: Number(s.biayaJasa) || 0 }] : [];
      }
    });

    return merged;
  }

  let isFreshDeviceBoot = false;
  let db = loadDatabase();
  let currentUser = loadSession();
  let activeMenu = 'dashboard';
  let filterDateStart = '';
  let filterDateEnd = '';

  // State Kasir POS (persisten saat render ulang agar input pelanggan/catatan tidak terhapus)
  let posCart = [];
  let posServices = []; // [{ nama: 'Jasa Pasang LCD', biaya: 50000 }]
  let posDiscount = 0;
  let posSearchQuery = '';
  let posCustomer = '';
  let posContact = '';
  let posAccountId = (db.akunKas[0] && db.akunKas[0].id) || 'ACC-TUNAI';
  let posNote = '';
  let posPaidOverride = null; // null = ikuti totalAkhir otomatis

  // State Pencarian & Draf Modal Servis
  let stokSearchQuery = '';
  let editingServiceDraft = null;

  function loadDatabase() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.karyawan && parsed.barang) {
          const migrated = migrateDatabase(parsed);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
          return migrated;
        }
      }
    } catch (e) {}
    isFreshDeviceBoot = true;
    const seed = createInitialDatabase();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    return seed;
  }

  function saveDatabase(auditAction, auditTarget, auditDetail) {
    if (auditAction) {
      db.logAudit.unshift({
        id: genId('LOG'),
        waktu: nowStr(),
        pelaku: currentUser ? currentUser.username : 'GUEST',
        aksi: auditAction,
        target: auditTarget || '-',
        detail: auditDetail || ''
      });
      if (db.logAudit.length > 300) db.logAudit = db.logAudit.slice(0, 300);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    syncToGoogleSheets(auditAction, auditTarget, auditDetail);
  }

  function loadSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const sess = JSON.parse(raw);
      const found = db.karyawan.find((u) => u.username === sess.username && u.aktif);
      return found || null;
    } catch (e) {
      return null;
    }
  }

  function saveSession(user) {
    if (!user) {
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(SESSION_KEY);
      currentUser = null;
      return;
    }
    currentUser = user;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ username: user.username }));
    localStorage.setItem(SESSION_KEY, JSON.stringify({ username: user.username }));
  }

  function rp(val) {
    const num = Number(val) || 0;
    return 'Rp' + num.toLocaleString('id-ID');
  }

  function showToast(msg, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const colors = {
      success: 'border-emerald-500/50 bg-emerald-950/90 text-emerald-200',
      error: 'border-rose-500/50 bg-rose-950/90 text-rose-200',
      info: 'border-sky-500/50 bg-sky-950/90 text-sky-200',
      warn: 'border-amber-500/50 bg-amber-950/90 text-amber-200'
    };
    const el = document.createElement('div');
    el.className = `pointer-events-auto px-4 py-3 rounded-xl border backdrop-blur-lg shadow-2xl text-xs sm:text-sm font-semibold transition-all duration-300 ${colors[type] || colors.info}`;
    el.innerHTML = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 3400);
  }

  // ==========================================================================
  // SERVICE WORKER & AUTO-UPDATE LOADING MUTER (PERINTAH KHUSUS USER)
  // ==========================================================================
  function triggerUpdateOverlay(title, desc) {
    if (isUpdatingOverlayActive) return;
    isUpdatingOverlayActive = true;
    const overlay = document.getElementById('sw-update-overlay');
    const titleEl = document.getElementById('sw-update-title');
    const descEl = document.getElementById('sw-update-desc');
    const barEl = document.getElementById('sw-update-bar');
    if (!overlay) return;
    if (title) titleEl.textContent = title;
    if (desc) descEl.textContent = desc;
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
    let pct = 25;
    const timer = setInterval(() => {
      pct = Math.min(95, pct + 15);
      if (barEl) barEl.style.width = pct + '%';
    }, 180);
    setTimeout(() => {
      clearInterval(timer);
      if (barEl) barEl.style.width = '100%';
      window.location.reload();
    }, 1250);
  }

  function initServiceWorkerAndAutoUpdate() {
    const currentAppVer = window.AZI_CONFIG.APP_VERSION;
    const savedVer = localStorage.getItem(VERSION_KEY);
    if (savedVer && savedVer !== currentAppVer) {
      localStorage.setItem(VERSION_KEY, currentAppVer);
      triggerUpdateOverlay(
        'Memperbarui ke Versi ' + currentAppVer + '...',
        'Perubahan terbaru terdeteksi. Menyelaraskan tampilan dan modul Azi Cell...'
      );
      return;
    }
    localStorage.setItem(VERSION_KEY, currentAppVer);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
        // Cek update setiap kali aplikasi dibuka
        reg.update().catch(() => {});

        if (reg.waiting) {
          triggerUpdateOverlay('Memperbarui Sistem Azi Cell...', 'Menerapkan pembaruan Service Worker terbaru...');
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }

        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              triggerUpdateOverlay('Update Baru Ditemukan!', 'Sedang memuat ulang aplikasi dengan versi terbaru...');
              newWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      }).catch(() => {});

      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'SW_UPDATED_READY') {
          const seenSwVer = localStorage.getItem('AZICELL_SW_VER');
          if (seenSwVer && seenSwVer !== event.data.version) {
            localStorage.setItem('AZICELL_SW_VER', event.data.version);
            triggerUpdateOverlay('Versi Terbaru Siap!', 'Memuat ulang halaman secara otomatis...');
          } else {
            localStorage.setItem('AZICELL_SW_VER', event.data.version);
          }
        }
      });

      // Cek update otomatis saat tab kembali dibuka
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          navigator.serviceWorker.getRegistration().then((reg) => {
            if (reg) reg.update().catch(() => {});
          });
        }
      });
    }
  }

  // Tangkap event instalasi PWA (Bab 02)
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    renderApp();
  });

  function isStandaloneInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  async function handleInstallClick() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        showToast('Azi Cell berhasil dipasang ke perangkat Anda!', 'success');
        deferredInstallPrompt = null;
      }
      renderApp();
      return;
    }
    // Tampilkan panduan instalasi sesuai perangkat (iPhone Safari / PC Chrome / Edge) sesuai Bab 02
    openModal(`
      <div class="glass-card rounded-2xl p-6 max-w-md w-full border border-sky-500/30 text-left">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-extrabold text-white">Panduan Instalasi Azi Cell</h3>
          <button onclick="window.AZI.closeModal()" class="text-slate-400 hover:text-white text-xl">&times;</button>
        </div>
        <p class="text-xs text-slate-300 mb-4">
          Pilih cara instalasi sesuai perangkat yang sedang Anda gunakan (Instalasi dapat dilakukan langsung tanpa perlu login terlebih dahulu):
        </p>
        <div class="space-y-3 text-xs">
          <div class="p-3 rounded-xl bg-slate-900/90 border border-slate-800">
            <div class="font-bold text-amber-400 mb-1">📱 iPhone / iPad (Safari)</div>
            <p class="text-slate-300">1. Ketuk tombol <b>Bagikan (Share)</b> di bagian bawah Safari.<br/>2. Pilih <b>Tambahkan ke Layar Utama (Add to Home Screen)</b>.<br/>3. Ketuk <b>Tambah</b> di pojok kanan atas.</p>
          </div>
          <div class="p-3 rounded-xl bg-slate-900/90 border border-slate-800">
            <div class="font-bold text-sky-400 mb-1">🤖 Android (Chrome / Edge)</div>
            <p class="text-slate-300">1. Ketuk ikon titik tiga <b>(⋮)</b> di pojok kanan atas browser.<br/>2. Pilih <b>Instal Aplikasi (Install App)</b> atau <b>Tambahkan ke Layar Utama</b>.</p>
          </div>
          <div class="p-3 rounded-xl bg-slate-900/90 border border-slate-800">
            <div class="font-bold text-emerald-400 mb-1">💻 PC / Laptop (Chrome / Edge / Safari Mac)</div>
            <p class="text-slate-300">Klik ikon <b>Instal Azi Cell</b> di sebelah kanan kolom alamat (Address Bar) browser, atau buka menu browser &gt; <b>Instal Azi Cell / Add to Dock</b>.</p>
          </div>
        </div>
        <button onclick="window.AZI.closeModal()" class="mt-5 w-full py-2.5 rounded-xl btn-cyber text-xs">Mengerti, Tutup Panduan</button>
      </div>
    `);
  }

  // ==========================================================================
  // SINKRONISASI GOOGLE SPREADSHEET (PUSH 12 SHEET & PULL DATA DUA ARAH)
  // ==========================================================================
  async function syncToGoogleSheets(action, target, detail, showFeedback = false) {
    const gasUrl = (db.config.gasWebAppUrl || '').trim();
    if (!gasUrl) return { ok: false, skipped: true };
    cloudSyncState.status = 'syncing';
    const payloadStr = JSON.stringify({
      action: action || 'SYNC_ALL',
      spreadsheetId: db.config.spreadsheetId,
      schema: window.AZI_CONFIG.SHEET_SCHEMA,
      payload: db,
      audit: {
        user: currentUser ? currentUser.username : 'SYSTEM',
        action: action || 'SYNC_ALL',
        target: target || '-',
        detail: detail || '',
        time: nowStr()
      }
    });
    try {
      // Gunakan text/plain agar menghindari preflight CORS di Google Apps Script Web App
      const resp = await fetch(gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: payloadStr
      });
      if (resp && resp.ok) {
        const json = await resp.json().catch(() => ({}));
        if (json && json.status === 'ERROR') {
          cloudSyncState = { status: 'error', lastSyncedAt: cloudSyncState.lastSyncedAt, message: json.message || 'Gagal sinkronisasi' };
          if (showFeedback) showToast('Gagal sinkron ke Spreadsheet: ' + esc(json.message || 'Error'), 'error');
          return { ok: false, message: json.message };
        }
        cloudSyncState = { status: 'ok', lastSyncedAt: nowStr(), message: 'Tersinkron ke 12 Sheet' };
        if (showFeedback) showToast('Berhasil sinkron seluruh 12 Sheet ke Google Spreadsheet!', 'success');
        return { ok: true, json };
      }
      throw new Error('HTTP ' + (resp ? resp.status : 'ERR'));
    } catch (err) {
      // Fallback aman ke mode no-cors jika lingkungan browser memblokir bacaan respons
      try {
        await fetch(gasUrl, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: payloadStr
        });
        cloudSyncState = { status: 'ok', lastSyncedAt: nowStr(), message: 'Terkirim ke Spreadsheet' };
        if (showFeedback) showToast('Data berhasil dikirim ke Google Spreadsheet!', 'success');
        return { ok: true, opaque: true };
      } catch (e2) {
        cloudSyncState = { status: 'error', lastSyncedAt: cloudSyncState.lastSyncedAt, message: 'Offline / Gagal terhubung' };
        if (showFeedback) showToast('Gagal mengirim ke Spreadsheet. Periksa koneksi internet & URL Web App.', 'error');
        return { ok: false, error: e2 };
      }
    }
  }

  async function pullFromGoogleSheets(opts = {}) {
    const silent = Boolean(opts && opts.silent);
    const onlyIfHasData = Boolean(opts && opts.onlyIfHasData);
    const gasUrl = (db.config.gasWebAppUrl || '').trim();
    if (!gasUrl) {
      if (!silent) showToast('URL Web App Google Apps Script belum diisi di menu Pengaturan!', 'warn');
      return;
    }
    if (!silent) showToast('Menarik data terbaru dari 12 Sheet Google Spreadsheet...', 'info');
    try {
      const sep = gasUrl.includes('?') ? '&' : '?';
      const url = `${gasUrl}${sep}action=pull&spreadsheetId=${encodeURIComponent(db.config.spreadsheetId || '')}`;
      const resp = await fetch(url, { method: 'GET' });
      const json = await resp.json();
      if (json && json.status === 'PULL_SUCCESS' && json.data) {
        const cloudHasTransactions =
          (Array.isArray(json.data.barang) && json.data.barang.length > 0) ||
          (Array.isArray(json.data.penjualan) && json.data.penjualan.length > 0) ||
          (Array.isArray(json.data.servis) && json.data.servis.length > 0);
        if (onlyIfHasData && !cloudHasTransactions) {
          cloudSyncState = { status: 'ok', lastSyncedAt: nowStr(), message: 'Terhubung (Spreadsheet baru)' };
          return;
        }
        const currentGasUrl = db.config.gasWebAppUrl;
        const currentSheetUrl = db.config.spreadsheetUrl;
        const pulled = migrateDatabase(json.data);
        pulled.config.gasWebAppUrl = currentGasUrl;
        if (!pulled.config.spreadsheetUrl) pulled.config.spreadsheetUrl = currentSheetUrl;
        db = pulled;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
        cloudSyncState = { status: 'ok', lastSyncedAt: nowStr(), message: 'Data ditarik dari Spreadsheet' };
        if (!silent) showToast('Data terbaru berhasil ditarik dari Google Spreadsheet!', 'success');
        else showToast('Sinkronisasi otomatis: data terbaru dimuat dari Google Spreadsheet.', 'info');
        renderApp();
      } else if (!silent) {
        showToast('Gagal tarik data: ' + esc((json && json.message) || 'Pastikan Code.gs sudah versi terbaru & di-deploy ulang.'), 'error');
      }
    } catch (err) {
      if (!silent) {
        showToast('Tidak dapat menarik data dari Spreadsheet. Pastikan Web App diakses "Anyone" & sudah deploy versi terbaru.', 'error');
      }
    }
  }

  // ==========================================================================
  // RENDER BADGE & KONTROL BLUETOOTH POJOK KANAN ATAS (MERAH / HIJAU)
  // ==========================================================================
  function renderBluetoothHeaderPill() {
    const isConnected = bluetoothStatus === 'connected' && Boolean(bluetoothCharacteristic);
    const isConnecting = bluetoothStatus === 'connecting';
    const pillClass = isConnected
      ? 'bt-pill-connected'
      : (isConnecting ? 'bt-pill-connecting' : 'bt-pill-disconnected');
    const dotClass = isConnected
      ? 'bg-emerald-400 animate-pulse shadow-[0_0_8px_#34d399]'
      : (isConnecting ? 'bg-amber-400 animate-ping' : 'bg-rose-500 shadow-[0_0_8px_#f43f5e]');
    const shortName = bluetoothDeviceName ? esc(bluetoothDeviceName.slice(0, 14)) : 'Terhubung';
    const labelText = isConnected
      ? `BT: ${shortName}`
      : (isConnecting ? 'BT: Menyambung...' : 'BT: Belum Konek');
    const titleAttr = isConnected
      ? `Printer Bluetooth terhubung (${esc(bluetoothDeviceName || 'Thermal')}). Klik untuk kelola / tes cetak.`
      : 'Printer Bluetooth belum terhubung. Klik untuk menghubungkan printer thermal.';

    return `
      <button
        id="header-bt-pill"
        type="button"
        onclick="window.AZI.handleBluetoothButtonClick()"
        title="${titleAttr}"
        class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] sm:text-xs font-extrabold transition-all cursor-pointer shrink-0 ${pillClass}"
      >
        <span class="w-2.5 h-2.5 rounded-full shrink-0 ${dotClass}"></span>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5 shrink-0">
          <path d="m7 7 10 10-5 5V2l5 5L7 17" />
        </svg>
        <span class="whitespace-nowrap">${labelText}</span>
      </button>
    `;
  }

  function updateBluetoothUiBadges() {
    const headerPill = document.getElementById('header-bt-pill');
    if (headerPill) {
      headerPill.outerHTML = renderBluetoothHeaderPill();
    }
    const sidebarStatus = document.getElementById('sidebar-bt-status');
    if (sidebarStatus) {
      const isConn = bluetoothStatus === 'connected' && Boolean(bluetoothCharacteristic);
      sidebarStatus.className = isConn ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold';
      sidebarStatus.textContent = isConn ? (bluetoothDeviceName || 'Terhubung') : 'Belum Konek';
    }
    const modalBleBtn = document.getElementById('modal-ble-print-btn');
    if (modalBleBtn) {
      const isConn = bluetoothStatus === 'connected' && Boolean(bluetoothCharacteristic);
      modalBleBtn.className = isConn
        ? 'py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-1.5'
        : 'py-2.5 px-3 rounded-xl bg-rose-600/80 hover:bg-rose-600 text-white font-bold text-xs flex items-center justify-center gap-1.5';
      modalBleBtn.innerHTML = isConn
        ? '<span>🖨️</span><span>Cetak Bluetooth (Siap)</span>'
        : '<span>🖨️</span><span>Konek & Cetak Bluetooth</span>';
    }
  }

  // ==========================================================================
  // KALKULASI KEUANGAN, SALDO AKUN, STOK, OMZET & LABA (BAB 06 & BAB 12)
  // ==========================================================================
  function getStokAkhir(item) {
    return (Number(item.stokAwal) || 0) + (Number(item.masuk) || 0) - (Number(item.keluar) || 0);
  }

  function getAccountBalances() {
    return db.akunKas.map((acc) => {
      let masuk = 0;
      let keluar = 0;
      db.kasModal.forEach((k) => {
        const nom = Number(k.nominal) || 0;
        if (k.jenis === 'Masuk' && k.akunTujuan === acc.id) masuk += nom;
        if (k.jenis === 'Keluar' && k.akunAsal === acc.id) keluar += nom;
        if (k.jenis === 'Transfer') {
          if (k.akunAsal === acc.id) keluar += nom;
          if (k.akunTujuan === acc.id) masuk += nom;
        }
      });
      const saldoAkhir = (Number(acc.saldoAwal) || 0) + masuk - keluar;
      return { ...acc, totalMasuk: masuk, totalKeluar: keluar, saldoAkhir };
    });
  }

  function isInDateFilter(dateStr) {
    if (!dateStr) return true;
    const d = dateStr.slice(0, 10);
    if (filterDateStart && d < filterDateStart) return false;
    if (filterDateEnd && d > filterDateEnd) return false;
    return true;
  }

  function calculateFinancialMetrics() {
    let omzetPenjualanBarang = 0;
    let omzetJasaPenjualan = 0;
    let hppPenjualanBarang = 0;
    let omzetJasaServis = 0;
    let omzetSparepartServis = 0;
    let hppSparepartServis = 0;
    let totalReturOmzet = 0;
    let totalReturModal = 0;

    // 1. Penjualan Final (Draf tidak masuk omzet - Bab 07; pisahkan Barang & Jasa Pasang POS)
    db.penjualan.forEach((p) => {
      if (p.statusDokumen === 'Final' && isInDateFilter(p.tanggalJam)) {
        if (!currentUser.akses.semua_transaksi && p.petugas !== currentUser.username) return;
        const totalAkhir = Number(p.totalAkhir) || 0;
        const totalJasaRaw = Number(p.totalJasa) || 0;
        const jasaNet = Math.min(totalAkhir, totalJasaRaw);
        const barangNet = Math.max(0, totalAkhir - jasaNet);
        omzetPenjualanBarang += barangNet;
        omzetJasaPenjualan += jasaNet;
        hppPenjualanBarang += Number(p.totalModalHistoris) || 0;
      }
    });

    // 2. Servis Selesai / Diambil (Perkiraan/DP belum omzet sampai Selesai - Bab 08)
    db.servis.forEach((s) => {
      if ((s.statusPengerjaan === 'Selesai' || s.statusPengerjaan === 'Diambil') && isInDateFilter(s.tanggalSelesai || s.tanggalTerima)) {
        if (!currentUser.akses.semua_transaksi && s.teknisi !== currentUser.username && s.petugasTerima !== currentUser.username) return;
        const diskon = Number(s.diskon) || 0;
        const biayaJasa = Number(s.biayaJasa) || 0;
        const totalPart = Number(s.totalSparepart) || 0;
        const jasaNet = Math.max(0, biayaJasa - diskon);
        const sisaDiskon = Math.max(0, diskon - biayaJasa);
        const partNet = Math.max(0, totalPart - sisaDiskon);
        omzetJasaServis += jasaNet;
        omzetSparepartServis += partNet;
        hppSparepartServis += Number(s.totalModalPart) || 0;
      }
    });

    // 3. Retur Penjualan (Bab 13)
    db.returKoreksi.forEach((r) => {
      if (r.jenis === 'Retur Penjualan' && isInDateFilter(r.tanggalJam)) {
        totalReturOmzet += Number(r.nilaiOmzet) || 0;
        totalReturModal += Number(r.nilaiModal) || 0;
      }
    });

    const omzetBersih = omzetPenjualanBarang + omzetJasaPenjualan + omzetJasaServis + omzetSparepartServis - totalReturOmzet;
    const totalHpp = hppPenjualanBarang + hppSparepartServis - totalReturModal;
    const labaKotor = omzetBersih - totalHpp;

    // 4. Arus Kas, Modal Pemilik, dan Biaya Operasional (Bab 12)
    let uangMasukPeriode = 0;
    let uangKeluarPeriode = 0;
    let biayaOperasional = 0;
    let modalDisetor = 0;
    let modalDitarik = 0;

    db.kasModal.forEach((k) => {
      if (!isInDateFilter(k.tanggalJam)) return;
      const nom = Number(k.nominal) || 0;
      if (k.jenis === 'Masuk') {
        uangMasukPeriode += nom;
        if (k.kategori === 'Setoran Modal Pemilik') modalDisetor += nom;
      } else if (k.jenis === 'Keluar') {
        uangKeluarPeriode += nom;
        if (k.kategori === 'Biaya Operasional') biayaOperasional += nom;
        if (k.kategori === 'Penarikan Modal Pemilik') modalDitarik += nom;
      }
    });

    const labaBersihOperasional = labaKotor - biayaOperasional;

    // 5. Nilai Persediaan (Modal Barang di Rak)
    let nilaiPersediaan = 0;
    let barangHampirHabis = 0;
    db.barang.forEach((b) => {
      if (!b.aktif) return;
      const akhir = getStokAkhir(b);
      nilaiPersediaan += akhir * (Number(b.hargaModal) || 0);
      if (akhir <= (Number(b.stokMinimum) || 0)) barangHampirHabis++;
    });

    // 6. Piutang Pelanggan (Final) & Utang Pemasok Belum Lunas
    let totalPiutang = 0;
    db.penjualan.forEach((p) => {
      if (p.statusDokumen === 'Final') totalPiutang += Number(p.sisaPiutang) || 0;
    });
    db.servis.forEach((s) => {
      if (s.statusPengerjaan === 'Selesai' || s.statusPengerjaan === 'Diambil') {
        totalPiutang += Number(s.sisaTagihan) || 0;
      }
    });

    let totalUtang = 0;
    db.pembelian.forEach((pb) => {
      totalUtang += Number(pb.sisaUtang) || 0;
    });

    const servisAktif = db.servis.filter((s) => s.statusPengerjaan === 'Diterima' || s.statusPengerjaan === 'Dikerjakan').length;

    return {
      omzetPenjualanBarang,
      omzetJasaPenjualan,
      omzetJasaServis,
      omzetSparepartServis,
      totalReturOmzet,
      omzetBersih,
      totalHpp,
      labaKotor,
      biayaOperasional,
      labaBersihOperasional,
      uangMasukPeriode,
      uangKeluarPeriode,
      modalDisetor,
      modalDitarik,
      nilaiPersediaan,
      barangHampirHabis,
      totalPiutang,
      totalUtang,
      servisAktif
    };
  }

  // ==========================================================================
  // MODAL DIALOG HELPER
  // ==========================================================================
  function openModal(html) {
    const m = document.getElementById('modal-root');
    if (!m) return;
    m.innerHTML = html;
    m.classList.remove('hidden');
    m.classList.add('flex');
  }

  function closeModal() {
    const m = document.getElementById('modal-root');
    if (!m) return;
    m.classList.add('hidden');
    m.classList.remove('flex');
    m.innerHTML = '';
  }

  // ==========================================================================
  // BAB 02: HALAMAN LOGIN & TOMBOL INSTAL DI BAWAH TOMBOL MASUK
  // ==========================================================================
  function renderLoginView() {
    const installed = isStandaloneInstalled();
    return `
      <div class="min-h-screen flex flex-col items-center justify-center px-4 py-10 relative">
        <div class="w-full max-w-md glass-card rounded-3xl p-7 sm:p-9 border border-white/10 relative overflow-hidden">
          <div class="absolute -top-24 -right-24 w-48 h-48 bg-amber-500/15 rounded-full blur-3xl pointer-events-none"></div>
          <div class="absolute -bottom-24 -left-24 w-48 h-48 bg-sky-500/15 rounded-full blur-3xl pointer-events-none"></div>

          <!-- 1. LOGO AZI CELL (Sesuai urutan Bab 02) -->
          <div class="flex flex-col items-center text-center mb-7">
            <div class="w-24 h-24 rounded-2xl bg-slate-900/90 border border-amber-500/30 p-2 flex items-center justify-center shadow-2xl mb-4">
              <img src="${db.config.logoUrl || 'logo1.png'}" alt="Logo Azi Cell" class="max-h-full max-w-full object-contain rounded-xl" onerror="this.src='icon-192.png'" />
            </div>
            <h1 class="text-2xl sm:text-3xl font-extrabold tracking-tight gold-gradient-text">${db.config.namaToko}</h1>
            <p class="text-xs text-slate-400 mt-1">${db.config.tagline}</p>
          </div>

          <form onsubmit="window.AZI.submitLogin(event)" class="space-y-4">
            <!-- 2. USERNAME -->
            <div>
              <label class="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1.5">Username</label>
              <input id="login-username" type="text" required autocomplete="username" placeholder="Masukkan username akun..." class="w-full px-4 py-3 rounded-xl bg-slate-900/90 border border-slate-700/80 text-white text-sm focus:outline-none focus:border-amber-400" />
            </div>

            <!-- 3. PASSWORD -->
            <div>
              <label class="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1.5">Password</label>
              <input id="login-password" type="password" required autocomplete="current-password" placeholder="Masukkan password..." class="w-full px-4 py-3 rounded-xl bg-slate-900/90 border border-slate-700/80 text-white text-sm focus:outline-none focus:border-amber-400" />
            </div>

            <div id="login-error-box" class="hidden p-3 rounded-xl bg-rose-950/80 border border-rose-500/40 text-xs text-rose-200 font-medium"></div>

            <!-- 4. [MASUK] -->
            <button type="submit" class="w-full py-3.5 rounded-xl btn-luxury text-sm tracking-wide uppercase">
              Masuk
            </button>

            <!-- 5. [INSTAL AZI CELL] (Tepat di bawah tombol Masuk sesuai Bab 02) -->
            ${!installed ? `
              <button type="button" onclick="window.AZI.handleInstallClick()" class="w-full py-3 rounded-xl bg-slate-800/90 hover:bg-slate-800 border border-sky-400/40 text-sky-300 font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition">
                <span>📲 Instal Azi Cell (HP / PC)</span>
              </button>
            ` : ''}
          </form>

          <!-- Pintasan Uji Akun sesuai akun aktif di database -->
          <div class="mt-6 pt-5 border-t border-slate-800/80">
            <div class="text-[11px] font-semibold text-slate-400 mb-2 text-center">Pintasan Akun Aktif (Password awal: <span class="text-amber-300 font-mono-num">123</span>):</div>
            <div class="flex flex-wrap justify-center gap-1.5">
              ${db.karyawan.filter((k) => k.aktif).slice(0, 6).map((u) => `
                <button type="button" onclick="window.AZI.fillDemoLogin('${esc(u.username)}')" class="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/70 text-[11px] font-bold text-slate-300 capitalize">
                  ${esc(u.username)} <span class="text-[10px] text-amber-400">(${esc(u.jabatan)})</span>
                </button>
              `).join('')}
            </div>
          </div>
        </div>
        <div class="mt-4 text-[11px] text-slate-500 flex items-center gap-2">
          <span>Azi Cell PWA v${window.AZI_CONFIG.APP_VERSION}</span>
          <span>•</span>
          <button onclick="window.AZI.forceCheckUpdate()" class="text-sky-400 hover:underline">Cek Update Server</button>
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // MAIN SHELL & NAVIGASI SESUAI HAK AKSES (BAB 04 & 05)
  // ==========================================================================
  const MENU_META = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'penjualan', label: 'Penjualan', icon: '🛒' },
    { id: 'servis', label: 'Servis', icon: '🛠️' },
    { id: 'stok', label: 'Barang & Stok', icon: '📦' },
    { id: 'pembelian', label: 'Pembelian', icon: '🚚' },
    { id: 'pembayaran', label: 'Pembayaran & Tagihan', icon: '💳' },
    { id: 'kas', label: 'Kas & Modal', icon: '🏦' },
    { id: 'retur', label: 'Retur & Koreksi', icon: '↩️' },
    { id: 'laporan', label: 'Laporan', icon: '📈' },
    { id: 'karyawan', label: 'Karyawan', icon: '👥' },
    { id: 'pengaturan', label: 'Pengaturan', icon: '⚙️' }
  ];

  function renderMainLayout() {
    // Pastikan sesi aktif masih valid (Bab 04.C)
    const freshUser = db.karyawan.find((u) => u.username === currentUser.username);
    if (!freshUser || !freshUser.aktif) {
      saveSession(null);
      showToast('Sesi berakhir atau akun telah dinonaktifkan oleh Pemilik.', 'error');
      return renderLoginView();
    }
    currentUser = freshUser;

    // Jika akun memiliki password sementara (wajib ganti saat login pertama - Bab 04.A.3)
    if (currentUser.wajibGantiPassword) {
      return renderForceChangePasswordView();
    }

    const allowedMenus = MENU_META.filter((m) => currentUser.akses.menus.includes(m.id));
    if (!allowedMenus.some((m) => m.id === activeMenu)) {
      activeMenu = allowedMenus[0] ? allowedMenus[0].id : 'dashboard';
    }

    return `
      <div class="flex-1 flex flex-col lg:flex-row min-h-screen">
        <!-- SIDEBAR PC -->
        <aside class="hidden lg:flex lg:w-64 xl:w-72 flex-col glass-card border-r border-white/10 p-5 sticky top-0 h-screen">
          <div class="flex items-center gap-3 pb-5 border-b border-slate-800">
            <img src="${db.config.logoUrl || 'logo1.png'}" class="w-11 h-11 rounded-xl object-contain bg-slate-900 p-1 border border-amber-500/30" onerror="this.src='icon-192.png'" />
            <div class="overflow-hidden">
              <div class="font-extrabold text-base gold-gradient-text truncate">${db.config.namaToko}</div>
              <div class="text-[11px] text-slate-400 truncate">${currentUser.nama} • <span class="text-amber-400 font-semibold">${currentUser.jabatan}</span></div>
            </div>
          </div>

          <nav class="flex-1 py-4 space-y-1 overflow-y-auto">
            ${allowedMenus.map((m) => `
              <button onclick="window.AZI.navigate('${m.id}')" class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition ${activeMenu === m.id ? 'bg-gradient-to-r from-amber-500/20 to-sky-500/10 text-amber-300 border border-amber-500/30 shadow-lg' : 'text-slate-300 hover:bg-slate-800/60'}">
                <span class="text-base">${m.icon}</span>
                <span>${m.label}</span>
              </button>
            `).join('')}
          </nav>

          <div class="pt-4 border-t border-slate-800 space-y-2">
            <div class="flex items-center justify-between text-[11px] text-slate-400 px-1">
              <span>Printer BT: <b id="sidebar-bt-status" class="${bluetoothStatus === 'connected' && bluetoothCharacteristic ? 'text-emerald-400' : 'text-rose-400'}">${bluetoothStatus === 'connected' && bluetoothCharacteristic ? esc(bluetoothDeviceName || 'Terhubung') : 'Belum Konek'}</b></span>
              <span>${esc(db.config.lebarPrinter)} • v${window.AZI_CONFIG.APP_VERSION}</span>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <button onclick="window.AZI.openChangePasswordModal()" class="py-2 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[11px] font-bold text-slate-200">Ganti Sandi</button>
              <button onclick="window.AZI.logout()" class="py-2 px-3 rounded-xl bg-rose-950/70 hover:bg-rose-900 border border-rose-500/30 text-[11px] font-bold text-rose-200">Keluar</button>
            </div>
          </div>
        </aside>

        <!-- KONTEN UTAMA -->
        <div class="flex-1 flex flex-col min-w-0 pb-20 lg:pb-8">
          <!-- HEADER STICKY: FILTER TANGGAL & INDIKATOR BLUETOOTH POJOK KANAN ATAS (MERAH/HIJAU) -->
          <header class="glass-card sticky top-0 z-40 px-4 sm:px-6 py-3 border-b border-white/10 space-y-2.5">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2.5 min-w-0">
                <img src="${esc(db.config.logoUrl || 'logo1.png')}" class="w-9 h-9 rounded-lg object-contain bg-slate-900 p-1 border border-amber-500/30 lg:hidden shrink-0" onerror="this.src='icon-192.png'" />
                <div class="min-w-0">
                  <h2 class="text-sm sm:text-lg font-extrabold text-white flex items-center gap-1.5 truncate">
                    <span>${(MENU_META.find((m) => m.id === activeMenu) || {}).icon || ''}</span>
                    <span class="truncate">${(MENU_META.find((m) => m.id === activeMenu) || {}).label || 'Dashboard'}</span>
                  </h2>
                  <p class="text-[11px] text-slate-400 truncate">${esc(currentUser.nama)} (${esc(currentUser.jabatan)}) • ${esc(db.config.zonaWaktu)}</p>
                </div>
              </div>

              <!-- POJOK KANAN ATAS: FILTER DESKTOP + TOMBOL BLUETOOTH (MERAH=BELUM KONEK, HIJAU=KONEK) -->
              <div class="flex items-center gap-2 shrink-0 ml-auto">
                <div class="hidden xl:flex items-center gap-1.5">
                  <input type="date" value="${filterDateStart}" onchange="window.AZI.setDateFilter(this.value, '${filterDateEnd}')" class="px-2 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200" title="Dari Tanggal" />
                  <span class="text-xs text-slate-500">s/d</span>
                  <input type="date" value="${filterDateEnd}" onchange="window.AZI.setDateFilter('${filterDateStart}', this.value)" class="px-2 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200" title="Sampai Tanggal" />
                  ${(filterDateStart || filterDateEnd) ? `<button onclick="window.AZI.setDateFilter('', '')" class="px-2 py-1.5 rounded-lg bg-slate-800 text-[11px] text-amber-300 font-bold">Reset</button>` : ''}
                </div>
                ${renderBluetoothHeaderPill()}
                <button onclick="window.AZI.logout()" class="lg:hidden px-2.5 py-1.5 rounded-full bg-rose-950/80 border border-rose-500/30 text-[11px] font-bold text-rose-200">Keluar</button>
              </div>
            </div>

            <!-- BAR FILTER TANGGAL KHUSUS MOBILE & TABLET -->
            <div class="flex xl:hidden flex-wrap items-center gap-1.5 pt-1 border-t border-slate-800/70">
              <span class="text-[10px] font-bold text-slate-400 uppercase mr-1">Periode:</span>
              <input type="date" value="${filterDateStart}" onchange="window.AZI.setDateFilter(this.value, '${filterDateEnd}')" class="px-2 py-1 rounded-lg bg-slate-900 border border-slate-700 text-[11px] text-slate-200" title="Dari Tanggal" />
              <span class="text-[11px] text-slate-500">s/d</span>
              <input type="date" value="${filterDateEnd}" onchange="window.AZI.setDateFilter('${filterDateStart}', this.value)" class="px-2 py-1 rounded-lg bg-slate-900 border border-slate-700 text-[11px] text-slate-200" title="Sampai Tanggal" />
              ${(filterDateStart || filterDateEnd) ? `<button onclick="window.AZI.setDateFilter('', '')" class="px-2 py-1 rounded-lg bg-slate-800 text-[11px] text-amber-300 font-bold">Reset</button>` : ''}
            </div>
          </header>

          <!-- ISI HALAMAN DINAMIS -->
          <main class="p-4 sm:p-6 max-w-7xl w-full mx-auto space-y-6">
            ${renderActiveMenuContent()}
          </main>
        </div>

        <!-- BOTTOM NAVIGATION BAR (KHUSUS HP) -->
        <nav class="lg:hidden fixed bottom-0 inset-x-0 z-50 glass-card border-t border-white/10 px-2 py-1.5 flex items-center justify-around overflow-x-auto">
          ${allowedMenus.map((m) => `
            <button onclick="window.AZI.navigate('${m.id}')" class="flex flex-col items-center justify-center px-2.5 py-1 rounded-xl min-w-[60px] ${activeMenu === m.id ? 'text-amber-400 font-extrabold bg-amber-500/10' : 'text-slate-400 font-medium'}">
              <span class="text-base leading-none mb-1">${m.icon}</span>
              <span class="text-[10px] truncate">${m.label.split(' ')[0]}</span>
            </button>
          `).join('')}
        </nav>
      </div>
    `;
  }

  function renderForceChangePasswordView() {
    return `
      <div class="min-h-screen flex items-center justify-center p-4">
        <div class="glass-card rounded-2xl p-6 max-w-md w-full border border-amber-500/40">
          <h3 class="text-lg font-extrabold text-white mb-1">Aktivasi Keamanan Akun Baru</h3>
          <p class="text-xs text-slate-300 mb-4">Halo <b>${currentUser.nama}</b>, Anda login menggunakan password sementara. Silakan buat password baru Anda sebelum masuk ke dashboard.</p>
          <form onsubmit="window.AZI.submitNewPassword(event)" class="space-y-3">
            <input id="new-pass-1" type="password" required minlength="3" placeholder="Password Baru" class="w-full px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-sm text-white" />
            <input id="new-pass-2" type="password" required minlength="3" placeholder="Ulangi Password Baru" class="w-full px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-sm text-white" />
            <button type="submit" class="w-full py-3 rounded-xl btn-luxury text-xs uppercase">Simpan Password & Masuk</button>
          </form>
        </div>
      </div>
    `;
  }

  function renderActiveMenuContent() {
    switch (activeMenu) {
      case 'dashboard': return renderDashboardView();
      case 'penjualan': return renderPenjualanView();
      case 'servis': return renderServisView();
      case 'stok': return renderStokView();
      case 'pembelian': return renderPembelianView();
      case 'pembayaran': return renderPembayaranView();
      case 'kas': return renderKasModalView();
      case 'retur': return renderReturView();
      case 'laporan': return renderLaporanView();
      case 'karyawan': return renderKaryawanView();
      case 'pengaturan': return renderPengaturanView();
      default: return renderDashboardView();
    }
  }

  // ==========================================================================
  // BAB 05: DASHBOARD TOKO & TOMBOL CEPAT SESUAI IZIN
  // ==========================================================================
  function renderDashboardView() {
    const m = calculateFinancialMetrics();
    const balances = getAccountBalances();
    const totalSaldoKasBank = balances.reduce((s, a) => s + a.saldoAkhir, 0);
    const akses = currentUser.akses;

    return `
      <!-- TOMBOL CEPAT SESUAI IZIN AKUN (Bab 05) -->
      <div class="glass-panel rounded-2xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <span class="text-[11px] font-bold uppercase tracking-widest text-amber-400">Operasional Harian</span>
          <h3 class="text-base sm:text-lg font-extrabold text-white">Aksi Cepat Toko ${db.config.namaToko}</h3>
        </div>
        <div class="flex flex-wrap gap-2">
          ${akses.menus.includes('penjualan') ? `<button onclick="window.AZI.navigate('penjualan')" class="px-4 py-2.5 rounded-xl btn-luxury text-xs flex items-center gap-1.5"><span>🛒</span><span>Penjualan Baru</span></button>` : ''}
          ${akses.menus.includes('servis') ? `<button onclick="window.AZI.navigate('servis')" class="px-4 py-2.5 rounded-xl btn-cyber text-xs flex items-center gap-1.5"><span>🛠️</span><span>Terima Servis</span></button>` : ''}
          ${akses.menus.includes('pembelian') ? `<button onclick="window.AZI.navigate('pembelian')" class="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center gap-1.5"><span>📥</span><span>Barang Masuk</span></button>` : ''}
          ${akses.menus.includes('kas') ? `<button onclick="window.AZI.navigate('kas')" class="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs flex items-center gap-1.5"><span>💸</span><span>Catat Pengeluaran</span></button>` : ''}
        </div>
      </div>

      <!-- KPI RINGKASAN SESUAI HAK AKSES -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div class="glass-card rounded-2xl p-4 border-l-4 border-l-sky-400">
          <div class="text-[11px] font-semibold text-slate-400">Omzet Bersih (Penjualan & Servis)</div>
          <div class="text-lg sm:text-xl font-extrabold text-white font-mono-num mt-1">${rp(m.omzetBersih)}</div>
          <div class="text-[11px] text-sky-300 mt-1">Barang: ${rp(m.omzetPenjualanBarang)} | Jasa POS: ${rp(m.omzetJasaPenjualan)} | Servis: ${rp(m.omzetJasaServis + m.omzetSparepartServis)}</div>
        </div>

        ${akses.lihat_laba ? `
          <div class="glass-card rounded-2xl p-4 border-l-4 border-l-amber-400">
            <div class="text-[11px] font-semibold text-slate-400">Laba Kotor / Laba Bersih</div>
            <div class="text-lg sm:text-xl font-extrabold text-amber-300 font-mono-num mt-1">${rp(m.labaKotor)}</div>
            <div class="text-[11px] text-emerald-300 mt-1">Laba Bersih Ops: <b>${rp(m.labaBersihOperasional)}</b></div>
          </div>
        ` : `
          <div class="glass-card rounded-2xl p-4 border-l-4 border-l-amber-400">
            <div class="text-[11px] font-semibold text-slate-400">Servis Dalam Pengerjaan</div>
            <div class="text-lg sm:text-xl font-extrabold text-amber-300 font-mono-num mt-1">${m.servisAktif} Unit</div>
            <div class="text-[11px] text-slate-400 mt-1">Status Diterima & Dikerjakan</div>
          </div>
        `}

        ${akses.menus.includes('kas') || akses.lihat_laba ? `
          <div class="glass-card rounded-2xl p-4 border-l-4 border-l-emerald-400">
            <div class="text-[11px] font-semibold text-slate-400">Total Saldo Kas & Bank</div>
            <div class="text-lg sm:text-xl font-extrabold text-emerald-300 font-mono-num mt-1">${rp(totalSaldoKasBank)}</div>
            <div class="text-[11px] text-slate-300 mt-1">Masuk: ${rp(m.uangMasukPeriode)} | Keluar: ${rp(m.uangKeluarPeriode)}</div>
          </div>
        ` : `
          <div class="glass-card rounded-2xl p-4 border-l-4 border-l-emerald-400">
            <div class="text-[11px] font-semibold text-slate-400">Uang Masuk Kasir</div>
            <div class="text-lg sm:text-xl font-extrabold text-emerald-300 font-mono-num mt-1">${rp(m.uangMasukPeriode)}</div>
            <div class="text-[11px] text-slate-400 mt-1">Pembayaran Tunai, Transfer & QRIS</div>
          </div>
        `}

        <div class="glass-card rounded-2xl p-4 border-l-4 border-l-rose-400">
          <div class="text-[11px] font-semibold text-slate-400">Tagihan & Peringatan Stok</div>
          <div class="text-sm sm:text-base font-extrabold text-rose-300 font-mono-num mt-1">Piutang: ${rp(m.totalPiutang)}</div>
          <div class="text-[11px] text-amber-300 mt-1">Utang: ${rp(m.totalUtang)} • Stok Tipis: <b>${m.barangHampirHabis} SKU</b></div>
        </div>
      </div>

      <!-- POSISI SALDO PER AKUN & SERVIS AKTIF -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div class="glass-card rounded-2xl p-5 lg:col-span-2">
          <div class="flex items-center justify-between mb-4">
            <h4 class="text-sm font-extrabold text-white">Antrean Servis & Transaksi Terbaru</h4>
            <button onclick="window.AZI.navigate('servis')" class="text-xs text-sky-400 font-bold hover:underline">Lihat Semua &rarr;</button>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead>
                <tr class="border-b border-slate-800 text-slate-400">
                  <th class="py-2">No. Servis</th>
                  <th class="py-2">Pelanggan & HP</th>
                  <th class="py-2">Status Kerja</th>
                  <th class="py-2">Status Bayar</th>
                  <th class="py-2 text-right">Total / Sisa</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-800/60">
                ${db.servis.length === 0 ? `<tr><td colspan="5" class="py-6 text-center text-slate-500">Belum ada antrean servis.</td></tr>` : db.servis.slice(0, 5).map((s) => `
                  <tr>
                    <td class="py-2.5 font-mono-num font-bold text-amber-300">${esc(s.no)}</td>
                    <td class="py-2.5">
                      <div class="font-bold text-white">${esc(s.pelanggan)}</div>
                      <div class="text-[11px] text-slate-400">${esc(s.merekModel)} — ${esc(s.jenisServis)}</div>
                    </td>
                    <td class="py-2.5"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/20 text-sky-300">${esc(s.statusPengerjaan)}</span></td>
                    <td class="py-2.5"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${s.statusBayar === 'Lunas' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">${esc(s.statusBayar)}</span></td>
                    <td class="py-2.5 text-right font-mono-num">
                      <div class="font-bold text-white">${rp(s.totalBiayaFinal || s.estimasiBiaya)}</div>
                      <div class="text-[10px] text-rose-300">Sisa: ${rp(s.sisaTagihan)}</div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="glass-card rounded-2xl p-5 space-y-4">
          <h4 class="text-sm font-extrabold text-white">Posisi Kas & Persediaan</h4>
          ${(akses.menus.includes('kas') || akses.lihat_laba) ? balances.map((a) => `
            <div class="p-3 rounded-xl bg-slate-900/90 border border-slate-800 flex items-center justify-between">
              <div>
                <div class="text-xs font-bold text-white">${esc(a.nama)}</div>
                <div class="text-[10px] text-slate-400">Awal: ${rp(a.saldoAwal)}</div>
              </div>
              <div class="text-sm font-extrabold text-emerald-400 font-mono-num">${rp(a.saldoAkhir)}</div>
            </div>
          `).join('') : `<p class="text-xs text-slate-400">Ringkasan saldo kas dan modal hanya ditampilkan untuk akun dengan izin Keuangan/Pemilik.</p>`}
          ${akses.lihat_modal ? `
            <div class="p-3 rounded-xl bg-indigo-950/40 border border-indigo-500/30 flex items-center justify-between">
              <div>
                <div class="text-xs font-bold text-indigo-200">Nilai Persediaan Barang</div>
                <div class="text-[10px] text-indigo-300/70">Terpisah dari Modal Pemilik</div>
              </div>
              <div class="text-sm font-extrabold text-indigo-300 font-mono-num">${rp(m.nilaiPersediaan)}</div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // BAB 07: PENJUALAN BARANG + JASA PASANG (CONTOH: BELI LCD + JASA PASANG)
  // ==========================================================================
  function renderPosCatalogCards(queryText) {
    const q = String(queryText || '').trim().toLowerCase();
    const activeItems = db.barang.filter((b) => {
      if (!b.aktif) return false;
      if (!q) return true;
      return (
        String(b.nama || '').toLowerCase().includes(q) ||
        String(b.sku || '').toLowerCase().includes(q) ||
        String(b.barcode || '').toLowerCase().includes(q) ||
        String(b.kategori || '').toLowerCase().includes(q)
      );
    });
    if (activeItems.length === 0) {
      return `<div class="col-span-full py-8 text-center text-xs text-slate-400">Tidak ada barang yang cocok dengan pencarian "${esc(queryText)}".</div>`;
    }
    return activeItems.map((b) => {
      const stok = getStokAkhir(b);
      return `
        <div class="p-3.5 rounded-xl bg-slate-900/90 border ${stok <= b.stokMinimum ? 'border-amber-500/40' : 'border-slate-800'} flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="text-[10px] font-mono-num text-sky-400">${esc(b.sku)} • Stok: <b class="${stok > 0 ? 'text-emerald-400' : 'text-rose-400'}">${stok} ${esc(b.satuan)}</b></div>
            <div class="text-xs font-bold text-white mt-0.5 truncate" title="${esc(b.nama)}">${esc(b.nama)}</div>
            <div class="text-xs font-extrabold text-amber-400 font-mono-num mt-1">${rp(b.hargaJual)}</div>
          </div>
          <button onclick="window.AZI.addToPosCart('${esc(b.sku)}')" ${stok <= 0 ? 'disabled' : ''} class="px-3 py-2 rounded-xl shrink-0 ${stok > 0 ? 'btn-luxury' : 'bg-slate-800 text-slate-500 cursor-not-allowed'} text-xs">
            + Keranjang
          </button>
        </div>
      `;
    }).join('');
  }

  function renderPenjualanView() {
    const subtotalBarang = posCart.reduce((s, i) => s + i.qty * i.hargaJual, 0);
    const totalJasa = posServices.reduce((s, j) => s + (Number(j.biaya) || 0), 0);
    const subtotal = subtotalBarang + totalJasa;
    const totalAkhir = Math.max(0, subtotal - (Number(posDiscount) || 0));
    const currentPaid = posPaidOverride !== null ? posPaidOverride : totalAkhir;
    const selisih = currentPaid - totalAkhir;

    const filteredSales = db.penjualan.filter((p) => {
      if (!currentUser.akses.semua_transaksi && p.petugas !== currentUser.username) return false;
      return isInDateFilter(p.tanggalJam);
    });

    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- KATALOG PILIH BARANG -->
        <div class="lg:col-span-7 glass-card rounded-2xl p-5 space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-sm font-extrabold text-white">Katalog Barang Siap Jual</h3>
            <input id="pos-search" type="text" value="${esc(posSearchQuery)}" oninput="window.AZI.filterPosCatalog(this.value)" placeholder="Cari nama barang / SKU / Barcode..." class="px-3.5 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white w-full sm:w-64" />
          </div>
          <div id="pos-catalog-grid" class="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[520px] overflow-y-auto pr-1">
            ${renderPosCatalogCards(posSearchQuery)}
          </div>
        </div>

        <!-- KERANJANG, JASA PASANG & PEMBAYARAN KASIR -->
        <div class="lg:col-span-5 glass-card rounded-2xl p-5 space-y-4">
          <div class="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 class="text-sm font-extrabold text-white">Keranjang Kasir</h3>
            <button onclick="window.AZI.clearPosCart()" class="text-[11px] text-rose-400 hover:underline">Kosongkan</button>
          </div>

          <!-- DAFTAR BARANG -->
          <div class="space-y-2 max-h-52 overflow-y-auto">
            ${posCart.length === 0 ? `<p class="text-xs text-slate-500 text-center py-4">Belum ada barang di keranjang.</p>` : posCart.map((c, idx) => `
              <div class="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between gap-2 text-xs">
                <div class="flex-1 min-w-0">
                  <div class="font-bold text-white truncate">${esc(c.nama)}</div>
                  <div class="flex items-center gap-2 mt-1">
                    <input type="number" min="1" value="${c.qty}" onchange="window.AZI.updatePosQty(${idx}, this.value)" class="w-16 px-2 py-1 rounded bg-slate-950 border border-slate-700 text-center font-mono-num" />
                    <span>&times;</span>
                    <input type="number" min="0" value="${c.hargaJual}" ${currentUser.akses.ubah_harga_diskon ? '' : 'readonly'} onchange="window.AZI.updatePosPrice(${idx}, this.value)" class="w-28 px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono-num ${currentUser.akses.ubah_harga_diskon ? 'text-amber-300' : 'text-slate-400'}" />
                  </div>
                </div>
                <div class="text-right shrink-0">
                  <div class="font-bold font-mono-num text-white">${rp(c.qty * c.hargaJual)}</div>
                  <button onclick="window.AZI.removePosItem(${idx})" class="text-[10px] text-rose-400 mt-1 hover:underline">Hapus</button>
                </div>
              </div>
            `).join('')}
          </div>

          <!-- TAMBAHAN JASA / ONGKOS PASANG (CONTOH: BELI LCD LALU PASANG) -->
          <div class="p-3.5 rounded-xl bg-sky-950/30 border border-sky-500/30 space-y-2.5 text-xs">
            <div class="flex items-center justify-between gap-2">
              <div class="font-extrabold text-sky-300 flex items-center gap-1.5">
                <span>🔧</span>
                <span>Tambahan Jasa / Ongkos Pasang</span>
              </div>
              <span class="text-[10px] text-slate-400">Tampil di Nota</span>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <button type="button" onclick="window.AZI.addPosService('Jasa Pasang LCD', 50000)" class="px-2 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/40 text-[10px] font-bold text-sky-200">+ Pasang LCD</button>
              <button type="button" onclick="window.AZI.addPosService('Jasa Pasang Baterai', 25000)" class="px-2 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/40 text-[10px] font-bold text-sky-200">+ Pasang Baterai</button>
              <button type="button" onclick="window.AZI.addPosService('Jasa Pasang Tempered Glass', 10000)" class="px-2 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/40 text-[10px] font-bold text-sky-200">+ Pasang TG</button>
              <button type="button" onclick="window.AZI.addPosService('Jasa Pasang Konektor / Part', 35000)" class="px-2 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/40 text-[10px] font-bold text-sky-200">+ Pasang Part</button>
              <button type="button" onclick="window.AZI.addPosService('', 0)" class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-[10px] font-bold text-amber-300">+ Jasa Lainnya</button>
            </div>
            ${posServices.length > 0 ? `
              <div class="space-y-2 pt-1">
                ${posServices.map((j, idx) => `
                  <div class="flex items-center gap-1.5 bg-slate-950/80 p-2 rounded-lg border border-sky-500/20">
                    <input type="text" value="${esc(j.nama)}" placeholder="Nama Jasa (mis: Jasa Pasang LCD)" oninput="window.AZI.updatePosServiceName(${idx}, this.value)" class="flex-1 min-w-0 px-2 py-1 rounded bg-slate-900 border border-slate-700 text-[11px] text-white" />
                    <input type="number" min="0" value="${Number(j.biaya) || 0}" placeholder="Rp" oninput="window.AZI.updatePosServiceFee(${idx}, this.value)" class="w-24 px-2 py-1 rounded bg-slate-900 border border-amber-500/40 text-right font-mono-num text-[11px] font-bold text-amber-300" />
                    <button type="button" onclick="window.AZI.removePosService(${idx})" class="px-2 py-1 rounded bg-rose-950/80 text-rose-300 font-bold text-[10px]">&times;</button>
                  </div>
                `).join('')}
              </div>
            ` : `<p class="text-[10px] text-slate-400">Klik tombol di atas jika pelanggan beli LCD / part sekalian pasang agar Biaya Jasa tercatat di Nota.</p>`}
          </div>

          <div class="space-y-2.5 pt-3 border-t border-slate-800 text-xs">
            <div class="flex justify-between text-slate-300">
              <span>Subtotal Barang</span>
              <span id="pos-subtotal-barang-display" class="font-mono-num font-bold">${rp(subtotalBarang)}</span>
            </div>
            ${posServices.length > 0 ? `
              <div class="flex justify-between text-sky-300">
                <span>Total Jasa / Ongkos Pasang</span>
                <span id="pos-total-jasa-display" class="font-mono-num font-bold">${rp(totalJasa)}</span>
              </div>
            ` : ''}
            <div class="flex justify-between text-slate-300">
              <span>Subtotal</span>
              <span id="pos-subtotal-display" class="font-mono-num font-bold">${rp(subtotal)}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-slate-300">Diskon (Rp) ${!currentUser.akses.ubah_harga_diskon ? '<span class="text-[10px] text-slate-500">(Terkunci)</span>' : ''}</span>
              <input type="number" min="0" value="${posDiscount}" ${currentUser.akses.ubah_harga_diskon ? '' : 'readonly'} oninput="window.AZI.setPosDiscount(this.value)" class="w-32 px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-700 text-right font-mono-num text-white" />
            </div>
            <div class="flex justify-between text-base font-extrabold text-amber-400 pt-1">
              <span>Total Akhir</span>
              <span id="pos-total-display" data-total="${totalAkhir}" class="font-mono-num">${rp(totalAkhir)}</span>
            </div>

            <div class="grid grid-cols-2 gap-2 pt-2">
              <input id="pos-pelanggan" type="text" value="${esc(posCustomer)}" oninput="window.AZI.setPosField('customer', this.value)" placeholder="Nama Pelanggan (Wajib jk kredit)" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white" />
              <input id="pos-kontak" type="text" value="${esc(posContact)}" oninput="window.AZI.setPosField('contact', this.value)" placeholder="No. WA / Kontak" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white" />
            </div>
            <input id="pos-catatan" type="text" value="${esc(posNote)}" oninput="window.AZI.setPosField('note', this.value)" placeholder="Catatan Nota / Garansi (Opsional, mis: Garansi LCD 7 hari)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white" />

            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-[10px] text-slate-400 mb-1">Metode & Akun Kas</label>
                <select id="pos-akun" onchange="window.AZI.setPosField('accountId', this.value)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white">
                  ${db.akunKas.map((a) => `<option value="${esc(a.id)}" ${posAccountId === a.id ? 'selected' : ''}>${esc(a.nama)} (${esc(a.tipe)})</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="block text-[10px] text-slate-400 mb-1">Uang Diterima (Rp)</label>
                <input id="pos-uang-diterima" type="number" min="0" value="${currentPaid}" oninput="window.AZI.recalcPosChange()" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-amber-500/50 text-xs font-mono-num font-bold text-emerald-300" />
              </div>
            </div>

            <!-- NOMINAL BAYAR CEPAT -->
            <div class="flex flex-wrap gap-1.5">
              <button type="button" onclick="window.AZI.setPosQuickPay(${totalAkhir})" class="px-2 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-[10px] font-bold text-emerald-300">Uang Pas</button>
              ${[50000, 100000, 200000, 500000].map((nom) => `
                <button type="button" onclick="window.AZI.setPosQuickPay(${nom})" class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] font-mono-num font-bold text-slate-200">${rp(nom)}</button>
              `).join('')}
            </div>

            <div id="pos-change-info" class="p-2.5 rounded-xl bg-slate-900/90 border border-slate-800 flex justify-between items-center text-xs">
              ${selisih >= 0
                ? `<span class="text-slate-400">Kembalian Tunai:</span><span class="font-mono-num font-bold text-emerald-400">${rp(selisih)} (Lunas)</span>`
                : `<span class="text-slate-400">Sisa Piutang Pelanggan:</span><span class="font-mono-num font-bold text-rose-400">${rp(Math.abs(selisih))} (Belum Lunas)</span>`}
            </div>

            <div class="grid grid-cols-2 gap-2 pt-2">
              <button type="button" onclick="window.AZI.savePosTransaction('Draf')" class="py-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-bold text-slate-200">
                Simpan Draf
              </button>
              <button type="button" onclick="window.AZI.savePosTransaction('Final')" class="py-3 rounded-xl btn-luxury text-xs">
                Simpan Final & Nota
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- RIWAYAT PENJUALAN -->
      <div class="glass-card rounded-2xl p-5">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 class="text-sm font-extrabold text-white">Riwayat Transaksi Penjualan</h3>
          <span class="text-[11px] text-slate-400">${filteredSales.length} transaksi${(filterDateStart || filterDateEnd) ? ' (Filter tanggal aktif)' : ''}</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead>
              <tr class="border-b border-slate-800 text-slate-400">
                <th class="py-2">No. Transaksi</th>
                <th class="py-2">Waktu</th>
                <th class="py-2">Pelanggan & Ringkasan</th>
                <th class="py-2">Dokumen</th>
                <th class="py-2">Total</th>
                <th class="py-2">Status Bayar</th>
                <th class="py-2 text-right">Aksi / Cetak</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800/60">
              ${filteredSales.length === 0 ? `<tr><td colspan="7" class="py-6 text-center text-slate-500">Belum ada transaksi penjualan pada periode ini.</td></tr>` : filteredSales.map((p) => `
                <tr>
                  <td class="py-2.5 font-mono-num font-bold text-amber-300">${esc(p.no)}</td>
                  <td class="py-2.5 text-slate-300">${esc(p.tanggalJam)}</td>
                  <td class="py-2.5">
                    <div class="font-semibold text-white">${esc(p.pelanggan)}</div>
                    ${(p.jasaItems && p.jasaItems.length > 0) ? `<div class="text-[10px] text-sky-300">+ Jasa: ${esc(p.jasaItems.map((j) => j.nama).join(', '))} (${rp(p.totalJasa)})</div>` : ''}
                  </td>
                  <td class="py-2.5"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${p.statusDokumen === 'Final' ? 'bg-sky-500/20 text-sky-300' : 'bg-slate-700 text-slate-300'}">${esc(p.statusDokumen)}</span></td>
                  <td class="py-2.5 font-mono-num font-bold text-white">${rp(p.totalAkhir)}</td>
                  <td class="py-2.5">
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${p.statusBayar === 'Lunas' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">${esc(p.statusBayar)}</span>
                    ${p.sisaPiutang > 0 ? `<div class="text-[10px] text-rose-300 font-mono-num">Piutang: ${rp(p.sisaPiutang)}</div>` : ''}
                  </td>
                  <td class="py-2.5 text-right space-x-1 whitespace-nowrap">
                    ${p.statusDokumen === 'Final' ? `
                      ${currentUser.akses.cetak_ulang ? `<button onclick="window.AZI.openReceiptModal('PENJUALAN', '${esc(p.no)}')" class="px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/40 text-sky-300 font-bold text-[11px]">Nota / Invoice</button>` : `<span class="text-[10px] text-slate-500">Cetak terkunci</span>`}
                    ` : `
                      <button onclick="window.AZI.finalizeDraftSale('${esc(p.no)}')" class="px-2.5 py-1 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-bold text-[11px]">Finalisasi</button>
                      <button onclick="window.AZI.deleteDraftSale('${esc(p.no)}')" class="px-2 py-1 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-300 font-bold text-[11px]">Hapus</button>
                    `}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // BAB 08: PENERIMAAN & PENGERJAAN SERVIS (DITERIMA > DIKERJAKAN > SELESAI > DIAMBIL)
  // ==========================================================================
  function renderServisView() {
    const list = db.servis.filter((s) => {
      if (!currentUser.akses.semua_transaksi && s.teknisi !== currentUser.username && s.petugasTerima !== currentUser.username) return false;
      return isInDateFilter(s.tanggalTerima);
    });
    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- FORM TERIMA SERVIS BARU -->
        <div class="lg:col-span-5 glass-card rounded-2xl p-5 space-y-3">
          <h3 class="text-sm font-extrabold text-white border-b border-slate-800 pb-2.5">Terima Servis Perangkat Baru</h3>
          <form onsubmit="window.AZI.submitNewService(event)" class="space-y-3 text-xs">
            <div class="grid grid-cols-2 gap-2">
              <input id="srv-pelanggan" type="text" required placeholder="Nama Pelanggan *" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
              <input id="srv-kontak" type="text" required placeholder="No. WA / Kontak *" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
            </div>
            <div class="grid grid-cols-2 gap-2">
              <input id="srv-perangkat" type="text" required placeholder="Perangkat (mis: HP / Tablet) *" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
              <input id="srv-merek" type="text" required placeholder="Merek & Tipe (mis: iPhone 11) *" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
            </div>
            <input id="srv-jenis" type="text" required placeholder="Jenis Servis (mis: Ganti LCD + Pasang / IC / Matot) *" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
            <textarea id="srv-keluhan" rows="2" required placeholder="Keluhan detail pelanggan *" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white"></textarea>
            <input id="srv-kelengkapan" type="text" placeholder="Kondisi & Kelengkapan (mis: Unit saja, lecet casing)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-[10px] text-slate-400 mb-1">Perkiraan Biaya (Belum Omzet)</label>
                <input id="srv-estimasi" type="number" min="0" value="0" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
              </div>
              <div>
                <label class="block text-[10px] text-slate-400 mb-1">Uang Muka / DP Diterima (Rp)</label>
                <input id="srv-dp" type="number" min="0" value="0" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-emerald-500/40 text-emerald-300 font-mono-num" />
              </div>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-[10px] text-slate-400 mb-1">Akun Penerima DP</label>
                <select id="srv-akun" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                  ${db.akunKas.map((a) => `<option value="${esc(a.id)}">${esc(a.nama)}</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="block text-[10px] text-slate-400 mb-1">Teknisi Penanggung Jawab</label>
                <select id="srv-teknisi" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                  ${db.karyawan.filter((k) => k.aktif).map((k) => `<option value="${esc(k.username)}" ${k.username === currentUser.username ? 'selected' : ''}>${esc(k.nama)} (${esc(k.jabatan)})</option>`).join('')}
                </select>
              </div>
            </div>
            <button type="submit" class="w-full py-3 rounded-xl btn-cyber text-xs uppercase">Simpan Penerimaan Servis</button>
          </form>
        </div>

        <!-- DAFTAR ANTREAN & PENGERJAAN SERVIS -->
        <div class="lg:col-span-7 glass-card rounded-2xl p-5 space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-sm font-extrabold text-white">Daftar Pengerjaan Servis (Diterima &rarr; Dikerjakan &rarr; Selesai &rarr; Diambil)</h3>
            <span class="text-[11px] text-slate-400">${list.length} unit</span>
          </div>
          <div class="space-y-3 max-h-[580px] overflow-y-auto pr-1">
            ${list.length === 0 ? `<p class="text-xs text-slate-500 text-center py-8">Belum ada data servis pada periode ini.</p>` : list.map((s) => `
              <div class="p-4 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-2.5 text-xs">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span class="font-mono-num font-extrabold text-amber-400 text-sm">${esc(s.no)}</span>
                    <span class="text-slate-400 ml-2">${esc(s.tanggalTerima)}</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold ${s.statusPengerjaan === 'Batal' ? 'bg-rose-500/20 text-rose-300' : (s.statusPengerjaan === 'Selesai' || s.statusPengerjaan === 'Diambil' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-sky-500/20 text-sky-300')}">${esc(s.statusPengerjaan)}</span>
                    <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold ${s.statusBayar === 'Lunas' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">${esc(s.statusBayar)}</span>
                  </div>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <div class="font-bold text-white">${esc(s.pelanggan)} (${esc(s.kontak)})</div>
                    <div class="text-slate-300">${esc(s.merekModel)} • <span class="text-sky-300">${esc(s.jenisServis)}</span></div>
                    <div class="text-[11px] text-slate-400">Keluhan: ${esc(s.keluhan)}</div>
                    ${s.spareparts && s.spareparts.length > 0 ? `<div class="text-[10px] text-amber-300/90 mt-0.5">Part: ${esc(s.spareparts.map((sp) => `${sp.nama} (${sp.qty}x)`).join(', '))}</div>` : ''}
                    ${s.namaJasa ? `<div class="text-[10px] text-sky-300/90">Jasa: ${esc(s.namaJasa)} (${rp(s.biayaJasa)})</div>` : ''}
                  </div>
                  <div class="sm:text-right font-mono-num">
                    <div class="text-slate-300">Sparepart: <b>${rp(s.totalSparepart)}</b> | Jasa: <b>${rp(s.biayaJasa)}</b></div>
                    ${Number(s.diskon) > 0 ? `<div class="text-[11px] text-amber-300">Diskon: -${rp(s.diskon)}</div>` : ''}
                    <div class="text-sm font-extrabold text-white">Total Final: ${rp(s.totalBiayaFinal || s.estimasiBiaya)}</div>
                    <div class="text-[11px] text-emerald-300">Sudah Bayar/DP: ${rp(s.totalTerbayar)} | <span class="text-rose-300">Sisa: ${rp(s.sisaTagihan)}</span></div>
                  </div>
                </div>
                <div class="pt-2 border-t border-slate-800 flex flex-wrap gap-2 justify-end">
                  <button onclick="window.AZI.openServiceWorkModal('${esc(s.no)}')" class="px-3 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 font-bold text-[11px]">
                    Update Status / Part & Jasa
                  </button>
                  ${(s.statusPengerjaan !== 'Batal' && s.sisaTagihan > 0) ? `
                    <button onclick="window.AZI.openPayModal('SERVIS', '${esc(s.no)}', ${s.sisaTagihan})" class="px-3 py-1.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 font-bold text-[11px]">
                      💳 Bayar Pelunasan
                    </button>
                  ` : ''}
                  <button onclick="window.AZI.openReceiptModal('SERVIS_TERIMA', '${esc(s.no)}')" class="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-[11px]">
                    Tanda Terima
                  </button>
                  ${(s.statusPengerjaan === 'Selesai' || s.statusPengerjaan === 'Diambil') ? `
                    <button onclick="window.AZI.openReceiptModal('SERVIS_FINAL', '${esc(s.no)}')" class="px-3 py-1.5 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/40 text-sky-300 font-bold text-[11px]">
                      Cetak Nota / Invoice
                    </button>
                  ` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // BAB 06: BARANG, STOK MASUK, PENYESUAIAN & RIWAYAT PERSIS RUMUS
  // ==========================================================================
  function renderStokTableRows(queryText) {
    const akses = currentUser.akses;
    const canManageStock = akses.lihat_modal || currentUser.jabatan === 'Pemilik' || currentUser.jabatan === 'Gudang';
    const q = String(queryText || '').trim().toLowerCase();
    const list = db.barang.filter((b) => {
      if (!q) return true;
      return (
        String(b.sku || '').toLowerCase().includes(q) ||
        String(b.nama || '').toLowerCase().includes(q) ||
        String(b.barcode || '').toLowerCase().includes(q) ||
        String(b.kategori || '').toLowerCase().includes(q)
      );
    });
    if (list.length === 0) {
      return `<tr><td colspan="9" class="py-6 text-center text-slate-500">Tidak ada barang ditemukan.</td></tr>`;
    }
    return list.map((b) => {
      const akhir = getStokAkhir(b);
      return `
        <tr class="${b.aktif ? '' : 'opacity-50'}">
          <td class="py-2.5 font-mono-num font-bold text-sky-400">${esc(b.sku)}</td>
          <td class="py-2.5">
            <div class="font-semibold text-white">${esc(b.nama)}</div>
            <div class="text-[10px] text-slate-400">${esc(b.kategori)} ${b.barcode && b.barcode !== '-' ? `• BC: ${esc(b.barcode)}` : ''}</div>
          </td>
          ${akses.lihat_modal ? `<td class="py-2.5 font-mono-num text-slate-300">${rp(b.hargaModal)}</td>` : ''}
          <td class="py-2.5 font-mono-num font-bold text-amber-300">${rp(b.hargaJual)}</td>
          <td class="py-2.5 text-center font-mono-num">${b.stokAwal}</td>
          <td class="py-2.5 text-center font-mono-num text-emerald-400">+${b.masuk}</td>
          <td class="py-2.5 text-center font-mono-num text-rose-400">-${b.keluar}</td>
          <td class="py-2.5 text-right font-mono-num font-extrabold ${akhir <= b.stokMinimum ? 'text-rose-400' : 'text-emerald-300'}">${akhir} ${esc(b.satuan)}</td>
          ${canManageStock ? `
            <td class="py-2.5 text-right whitespace-nowrap space-x-1">
              <button onclick="window.AZI.editMasterBarang('${esc(b.sku)}')" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 font-bold text-[10px]">Edit</button>
              <button onclick="window.AZI.toggleBarangActive('${esc(b.sku)}')" class="px-2 py-1 rounded ${b.aktif ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'} font-bold text-[10px]">${b.aktif ? 'Aktif' : 'Nonaktif'}</button>
            </td>
          ` : ''}
        </tr>
      `;
    }).join('');
  }

  function renderStokView() {
    const akses = currentUser.akses;
    const canManageStock = akses.lihat_modal || currentUser.jabatan === 'Pemilik' || currentUser.jabatan === 'Gudang';
    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        ${canManageStock ? `
          <!-- TAMBAH BARANG / PENYESUAIAN STOK (KHUSUS PEMILIK / GUDANG) -->
          <div class="lg:col-span-4 space-y-5">
            <div class="glass-card rounded-2xl p-5 space-y-3">
              <h3 class="text-sm font-extrabold text-white border-b border-slate-800 pb-2">Tambah / Edit Master Barang</h3>
              <form onsubmit="window.AZI.submitMasterBarang(event)" class="space-y-2.5 text-xs">
                <div class="grid grid-cols-2 gap-2">
                  <input id="brg-sku" type="text" required placeholder="Kode SKU Unik *" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
                  <input id="brg-barcode" type="text" placeholder="Barcode (Opsional)" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
                </div>
                <input id="brg-nama" type="text" required placeholder="Nama Lengkap Barang *" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
                <div class="grid grid-cols-2 gap-2">
                  <input id="brg-kategori" type="text" required placeholder="Kategori (Aksesoris/Part)" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
                  <input id="brg-satuan" type="text" required placeholder="Satuan (pcs/unit)" value="pcs" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <div>
                    <label class="block text-[10px] text-slate-400 mb-1">Harga Modal (Rp)</label>
                    <input id="brg-modal" type="number" min="0" required value="0" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
                  </div>
                  <div>
                    <label class="block text-[10px] text-slate-400 mb-1">Harga Jual (Rp)</label>
                    <input id="brg-jual" type="number" min="0" required value="0" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-amber-300 font-mono-num" />
                  </div>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <div>
                    <label class="block text-[10px] text-slate-400 mb-1">Saldo Stok Awal Rak</label>
                    <input id="brg-awal" type="number" min="0" value="0" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
                  </div>
                  <div>
                    <label class="block text-[10px] text-slate-400 mb-1">Batas Stok Minimum</label>
                    <input id="brg-min" type="number" min="0" value="3" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
                  </div>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <input id="brg-pemasok" type="text" placeholder="Pemasok (Opsional)" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
                  <input id="brg-catatan" type="text" placeholder="Catatan (Opsional)" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
                </div>
                <button type="submit" class="w-full py-2.5 rounded-xl btn-luxury text-xs">Simpan Data Barang</button>
              </form>
            </div>

            <div class="glass-card rounded-2xl p-5 space-y-3">
              <h3 class="text-sm font-extrabold text-white border-b border-slate-800 pb-2">Penyesuaian Stok (Opname / Rusak)</h3>
              <form onsubmit="window.AZI.submitStockAdjustment(event)" class="space-y-2.5 text-xs">
                <select id="adj-sku" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                  ${db.barang.map((b) => `<option value="${esc(b.sku)}">${esc(b.sku)} — ${esc(b.nama)} (Sisa: ${getStokAkhir(b)})</option>`).join('')}
                </select>
                <div class="grid grid-cols-2 gap-2">
                  <select id="adj-jenis" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                    <option value="KELUAR">Koreksi Keluar / Rusak</option>
                    <option value="MASUK">Koreksi Masuk / Opname+</option>
                  </select>
                  <input id="adj-qty" type="number" min="1" required placeholder="Jumlah Unit" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
                </div>
                <input id="adj-alasan" type="text" required placeholder="Alasan wajib (mis: Barang rusak / Stok Opname)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
                <button type="submit" class="w-full py-2.5 rounded-xl btn-cyber text-xs">Catat Penyesuaian Stok</button>
              </form>
            </div>
          </div>
        ` : ''}

        <!-- TABEL STOK BARANG & KARTU RIWAYAT GERAKAN -->
        <div class="${canManageStock ? 'lg:col-span-8' : 'lg:col-span-12'} space-y-5">
          <div class="glass-card rounded-2xl p-5">
            <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h3 class="text-sm font-extrabold text-white">Daftar Persediaan (Stok Akhir = Awal + Masuk - Keluar)</h3>
              <input id="stok-search" type="text" value="${esc(stokSearchQuery)}" oninput="window.AZI.filterStokTable(this.value)" placeholder="Cari SKU / Nama / Barcode..." class="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white w-full sm:w-56" />
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead>
                  <tr class="border-b border-slate-800 text-slate-400">
                    <th class="py-2">SKU</th>
                    <th class="py-2">Nama Barang</th>
                    ${akses.lihat_modal ? `<th class="py-2">Harga Modal</th>` : ''}
                    <th class="py-2">Harga Jual</th>
                    <th class="py-2 text-center">Awal</th>
                    <th class="py-2 text-center">Masuk</th>
                    <th class="py-2 text-center">Keluar</th>
                    <th class="py-2 text-right">Stok Tersisa</th>
                    ${canManageStock ? `<th class="py-2 text-right">Aksi</th>` : ''}
                  </tr>
                </thead>
                <tbody id="stok-table-body" class="divide-y divide-slate-800/60">
                  ${renderStokTableRows(stokSearchQuery)}
                </tbody>
              </table>
            </div>
          </div>

          <div class="glass-card rounded-2xl p-5">
            <h3 class="text-sm font-extrabold text-white mb-3">Kartu Riwayat Mutasi Stok & Petugas</h3>
            <div class="overflow-x-auto max-h-64">
              <table class="w-full text-left text-xs">
                <thead>
                  <tr class="border-b border-slate-800 text-slate-400">
                    <th class="py-2">Waktu</th>
                    <th class="py-2">Barang</th>
                    <th class="py-2">Sumber Gerakan</th>
                    <th class="py-2 text-center">Masuk/Keluar</th>
                    <th class="py-2 text-center">Sisa</th>
                    <th class="py-2">Petugas</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-800/60">
                  ${db.riwayatStok.map((m) => `
                    <tr>
                      <td class="py-2 text-slate-400">${esc(m.waktu)}</td>
                      <td class="py-2 font-semibold text-white">${esc(m.nama)}</td>
                      <td class="py-2 text-sky-300">${esc(m.jenis)} (${esc(m.ref)})</td>
                      <td class="py-2 text-center font-mono-num font-bold ${m.masuk > 0 ? 'text-emerald-400' : 'text-rose-400'}">${m.masuk > 0 ? '+' + m.masuk : '-' + m.keluar}</td>
                      <td class="py-2 text-center font-mono-num">${m.sesudah}</td>
                      <td class="py-2 text-slate-300">${esc(m.petugas)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // BAB 06.B: PEMBELIAN & BARANG MASUK PEMASOK (RATA-RATA TERTIMBANG MODAL)
  // ==========================================================================
  function renderPembelianView() {
    const firstItem = db.barang[0] || { hargaModal: 0 };
    const defaultQty = 1;
    const defaultHarga = Number(firstItem.hargaModal) || 0;
    const defaultTotal = defaultQty * defaultHarga;
    const filteredPb = db.pembelian.filter((pb) => isInDateFilter(pb.tanggal));

    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div class="lg:col-span-5 glass-card rounded-2xl p-5 space-y-3">
          <h3 class="text-sm font-extrabold text-white border-b border-slate-800 pb-2">Catat Barang Masuk / Pembelian Pemasok</h3>
          <form onsubmit="window.AZI.submitPembelian(event)" class="space-y-3 text-xs">
            <div class="grid grid-cols-2 gap-2">
              <input id="pb-pemasok" type="text" required placeholder="Nama Pemasok / Supplier *" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
              <input id="pb-ref" type="text" required placeholder="No. Nota Referensi *" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
            </div>
            <div>
              <label class="block text-[10px] text-slate-400 mb-1">Pilih Barang</label>
              <select id="pb-sku" onchange="window.AZI.onPembelianItemChange(this.value)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                ${db.barang.map((b) => `<option value="${esc(b.sku)}">${esc(b.sku)} — ${esc(b.nama)} (Modal: ${rp(b.hargaModal)})</option>`).join('')}
              </select>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-[10px] text-slate-400 mb-1">Jumlah Masuk (Satuan Stok)</label>
                <input id="pb-qty" type="number" min="1" required value="${defaultQty}" oninput="window.AZI.recalcPembelianTotal(true)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
              </div>
              <div>
                <label class="block text-[10px] text-slate-400 mb-1">Harga Beli Satuan (Rp)</label>
                <input id="pb-harga" type="number" min="0" required value="${defaultHarga}" oninput="window.AZI.recalcPembelianTotal(true)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-amber-300 font-mono-num" />
              </div>
            </div>
            <div class="p-3 rounded-xl bg-slate-900/90 border border-slate-800 flex items-center justify-between">
              <span class="text-slate-400">Total Pembelian:</span>
              <span id="pb-total-preview" class="text-sm font-extrabold font-mono-num text-amber-300">${rp(defaultTotal)}</span>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <div class="flex items-center justify-between mb-1">
                  <label class="text-[10px] text-slate-400">Dibayar Sekarang (Rp)</label>
                  <button type="button" onclick="window.AZI.fillPembelianFullPay()" class="text-[10px] text-emerald-400 font-bold hover:underline">Lunas</button>
                </div>
                <input id="pb-dibayar" type="number" min="0" required value="${defaultTotal}" oninput="window.AZI.recalcPembelianTotal(false)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-emerald-500/40 text-emerald-300 font-mono-num" />
              </div>
              <div>
                <label class="block text-[10px] text-slate-400 mb-1">Akun Pembayar</label>
                <select id="pb-akun" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                  ${db.akunKas.map((a) => `<option value="${esc(a.id)}">${esc(a.nama)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div id="pb-utang-preview" class="text-[11px] text-emerald-300 font-mono-num">Status: Lunas (Sisa Utang: Rp0)</div>
            <button type="submit" class="w-full py-3 rounded-xl btn-luxury text-xs uppercase">Simpan Barang Masuk & Update Stok</button>
          </form>
        </div>

        <div class="lg:col-span-7 glass-card rounded-2xl p-5">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-extrabold text-white">Riwayat Pembelian & Utang Pemasok</h3>
            <span class="text-[11px] text-slate-400">${filteredPb.length} nota</span>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead>
                <tr class="border-b border-slate-800 text-slate-400">
                  <th class="py-2">No. Beli</th>
                  <th class="py-2">Tanggal</th>
                  <th class="py-2">Pemasok & Barang</th>
                  <th class="py-2">Total</th>
                  <th class="py-2">Dibayar</th>
                  <th class="py-2">Sisa Utang</th>
                  <th class="py-2">Status</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-800/60">
                ${filteredPb.length === 0 ? `<tr><td colspan="7" class="py-6 text-center text-slate-500">Belum ada pembelian pada periode ini.</td></tr>` : filteredPb.map((pb) => `
                  <tr>
                    <td class="py-2.5 font-mono-num font-bold text-amber-300">${esc(pb.no)}</td>
                    <td class="py-2.5 text-slate-300">${esc(pb.tanggal)}</td>
                    <td class="py-2.5">
                      <div class="font-semibold text-white">${esc(pb.pemasok)}</div>
                      <div class="text-[10px] text-slate-400">${esc((pb.items || []).map((i) => `${i.nama} (${i.qty} ${i.satuan || ''})`).join(', '))}</div>
                    </td>
                    <td class="py-2.5 font-mono-num text-white">${rp(pb.total)}</td>
                    <td class="py-2.5 font-mono-num text-emerald-300">${rp(pb.dibayar)}</td>
                    <td class="py-2.5 font-mono-num text-rose-300 font-bold">${rp(pb.sisaUtang)}</td>
                    <td class="py-2.5"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${pb.statusBayar === 'Lunas' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">${esc(pb.statusBayar)}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // BAB 09: PEMBAYARAN PELANGGAN (PIUTANG) & PEMASOK (UTANG) TANPA OMZET GANDA
  // ==========================================================================
  function renderPembayaranView() {
    const piutangSales = db.penjualan.filter((p) => p.statusDokumen === 'Final' && p.sisaPiutang > 0);
    const piutangServis = db.servis.filter((s) => s.statusPengerjaan !== 'Batal' && s.sisaTagihan > 0);
    const utangBeli = db.pembelian.filter((pb) => pb.sisaUtang > 0);
    const historyPay = db.pembayaranTagihan.filter((p) => isInDateFilter(p.tanggalJam));

    return `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- PELUNASAN PIUTANG PELANGGAN -->
        <div class="glass-card rounded-2xl p-5 space-y-4">
          <h3 class="text-sm font-extrabold text-white">Pelunasan Tagihan Pelanggan (Penjualan & Servis)</h3>
          <p class="text-[11px] text-slate-400">Pelunasan menambah Uang Masuk Kas dan mengurangi Piutang tanpa menggandakan Omzet.</p>
          <div class="space-y-2.5">
            ${piutangServis.map((s) => `
              <div class="p-3.5 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between gap-2 text-xs">
                <div>
                  <div class="font-bold text-amber-300">${esc(s.no)} (Servis — ${esc(s.pelanggan)}) <span class="text-[10px] text-sky-300">[${esc(s.statusPengerjaan)}]</span></div>
                  <div class="text-slate-400">Total: ${rp(s.totalBiayaFinal || s.estimasiBiaya)} | Sudah Bayar: ${rp(s.totalTerbayar)}</div>
                  <div class="font-bold text-rose-400 font-mono-num">Sisa Tagihan: ${rp(s.sisaTagihan)}</div>
                </div>
                <button onclick="window.AZI.openPayModal('SERVIS', '${esc(s.no)}', ${s.sisaTagihan})" class="px-3 py-2 rounded-xl btn-luxury text-xs shrink-0">Terima Pelunasan</button>
              </div>
            `).join('')}
            ${piutangSales.map((p) => `
              <div class="p-3.5 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between gap-2 text-xs">
                <div>
                  <div class="font-bold text-sky-300">${esc(p.no)} (Penjualan — ${esc(p.pelanggan)})</div>
                  <div class="text-slate-400">Total: ${rp(p.totalAkhir)} | Sudah Bayar: ${rp(p.jumlahTerbayar)}</div>
                  <div class="font-bold text-rose-400 font-mono-num">Sisa Piutang: ${rp(p.sisaPiutang)}</div>
                </div>
                <button onclick="window.AZI.openPayModal('PENJUALAN', '${esc(p.no)}', ${p.sisaPiutang})" class="px-3 py-2 rounded-xl btn-luxury text-xs shrink-0">Terima Pelunasan</button>
              </div>
            `).join('')}
            ${piutangServis.length === 0 && piutangSales.length === 0 ? `<p class="text-xs text-emerald-400 py-4 text-center">Semua tagihan pelanggan sudah Lunas!</p>` : ''}
          </div>
        </div>

        <!-- PELUNASAN UTANG PEMASOK -->
        <div class="glass-card rounded-2xl p-5 space-y-4">
          <h3 class="text-sm font-extrabold text-white">Pelunasan Utang ke Pemasok</h3>
          <p class="text-[11px] text-slate-400">Pelunasan utang mencatat Uang Keluar dan mengurangi Utang tanpa menambah stok ganda.</p>
          <div class="space-y-2.5">
            ${utangBeli.map((pb) => `
              <div class="p-3.5 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between gap-2 text-xs">
                <div>
                  <div class="font-bold text-amber-300">${esc(pb.no)} (${esc(pb.pemasok)})</div>
                  <div class="text-slate-400">Total Beli: ${rp(pb.total)} | Sudah Bayar: ${rp(pb.dibayar)}</div>
                  <div class="font-bold text-rose-400 font-mono-num">Sisa Utang: ${rp(pb.sisaUtang)}</div>
                </div>
                <button onclick="window.AZI.openPayModal('PEMBELIAN', '${esc(pb.no)}', ${pb.sisaUtang})" class="px-3 py-2 rounded-xl btn-cyber text-xs shrink-0">Bayar Utang</button>
              </div>
            `).join('')}
            ${utangBeli.length === 0 ? `<p class="text-xs text-emerald-400 py-4 text-center">Tidak ada utang pemasok yang belum lunas.</p>` : ''}
          </div>
        </div>
      </div>

      <!-- RIWAYAT PEMBAYARAN TAGIHAN (SINKRON SHEET Pembayaran_Tagihan) -->
      <div class="glass-card rounded-2xl p-5">
        <h3 class="text-sm font-extrabold text-white mb-3">Riwayat Pembayaran DP, Piutang & Utang</h3>
        <div class="overflow-x-auto max-h-72">
          <table class="w-full text-left text-xs">
            <thead>
              <tr class="border-b border-slate-800 text-slate-400">
                <th class="py-2">Waktu</th>
                <th class="py-2">Jenis & No. Ref</th>
                <th class="py-2">Pihak Terkait</th>
                <th class="py-2">Metode / Ref</th>
                <th class="py-2 text-right">Nominal Bayar</th>
                <th class="py-2 text-right">Sisa Akhir</th>
                <th class="py-2">Petugas</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800/60">
              ${historyPay.length === 0 ? `<tr><td colspan="7" class="py-6 text-center text-slate-500">Belum ada riwayat pembayaran tagihan.</td></tr>` : historyPay.map((pay) => `
                <tr>
                  <td class="py-2 text-slate-400">${esc(pay.tanggalJam)}</td>
                  <td class="py-2 font-bold text-amber-300">${esc(pay.jenis)} (${esc(pay.noRef)})</td>
                  <td class="py-2 text-white">${esc(pay.pihak)}</td>
                  <td class="py-2 text-slate-300">${esc(pay.metode)}${pay.refTransfer ? ` • ${esc(pay.refTransfer)}` : ''}</td>
                  <td class="py-2 text-right font-mono-num font-bold text-emerald-400">${rp(pay.nominal)}</td>
                  <td class="py-2 text-right font-mono-num text-rose-300">${rp(pay.sisaAkhir)}</td>
                  <td class="py-2 text-slate-300">${esc(pay.petugas)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // BAB 12: KAS, MODAL PEMILIK, BIAYA OPERASIONAL & TRANSFER ANTAR AKUN
  // ==========================================================================
  function renderKasModalView() {
    const balances = getAccountBalances();
    const filteredKas = db.kasModal.filter((k) => isInDateFilter(k.tanggalJam));
    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div class="lg:col-span-5 glass-card rounded-2xl p-5 space-y-3">
          <h3 class="text-sm font-extrabold text-white border-b border-slate-800 pb-2">Catat Pengeluaran / Modal / Transfer Kas</h3>
          <form onsubmit="window.AZI.submitKasModal(event)" class="space-y-3 text-xs">
            <div>
              <label class="block text-[10px] text-slate-400 mb-1">Jenis Transaksi Kas</label>
              <select id="kas-kategori" onchange="window.AZI.toggleKasTransferUI()" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                <option value="KELUAR|Biaya Operasional">Pengeluaran Biaya Operasional (Listrik/Sewa/Gaji)</option>
                <option value="MASUK|Setoran Modal Pemilik">Setoran Modal Pemilik (Bukan Omzet)</option>
                <option value="KELUAR|Penarikan Modal Pemilik">Penarikan Modal / Prive Pemilik (Bukan Biaya Ops)</option>
                <option value="TRANSFER|Transfer Antar Akun">Transfer Antar Akun (Kas Tunai &harr; Bank)</option>
              </select>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div id="kas-asal-wrap">
                <label class="block text-[10px] text-slate-400 mb-1">Akun Asal / Sumber</label>
                <select id="kas-asal" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                  ${db.akunKas.map((a) => `<option value="${esc(a.id)}">${esc(a.nama)}</option>`).join('')}
                </select>
              </div>
              <div id="kas-tujuan-wrap" class="opacity-40 pointer-events-none">
                <label class="block text-[10px] text-slate-400 mb-1">Akun Tujuan (Masuk/Transfer)</label>
                <select id="kas-tujuan" disabled class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                  ${db.akunKas.map((a, idx) => `<option value="${esc(a.id)}" ${idx === 1 ? 'selected' : ''}>${esc(a.nama)}</option>`).join('')}
                </select>
              </div>
            </div>
            <input id="kas-nominal" type="number" min="1" required placeholder="Nominal (Rp) *" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
            <input id="kas-ket" type="text" required placeholder="Keterangan rincian (mis: Bayar Listrik Bulan Ini) *" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
            <button type="submit" class="w-full py-3 rounded-xl btn-luxury text-xs uppercase">Simpan Mutasi Kas</button>
          </form>
        </div>

        <div class="lg:col-span-7 space-y-5">
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            ${balances.map((a) => `
              <div class="glass-card rounded-2xl p-4">
                <div class="text-xs font-bold text-slate-300">${esc(a.nama)}</div>
                <div class="text-lg font-extrabold text-emerald-400 font-mono-num mt-1">${rp(a.saldoAkhir)}</div>
                <div class="text-[10px] text-slate-400 mt-1">Awal: ${rp(a.saldoAwal)}</div>
              </div>
            `).join('')}
          </div>

          <div class="glass-card rounded-2xl p-5">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-extrabold text-white">Buku Arus Kas & Modal</h3>
              <span class="text-[11px] text-slate-400">${filteredKas.length} mutasi</span>
            </div>
            <div class="overflow-x-auto max-h-80">
              <table class="w-full text-left text-xs">
                <thead>
                  <tr class="border-b border-slate-800 text-slate-400">
                    <th class="py-2">Waktu</th>
                    <th class="py-2">Kategori</th>
                    <th class="py-2">Keterangan</th>
                    <th class="py-2 text-right">Nominal</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-800/60">
                  ${filteredKas.length === 0 ? `<tr><td colspan="4" class="py-6 text-center text-slate-500">Belum ada mutasi kas pada periode ini.</td></tr>` : filteredKas.map((k) => `
                    <tr>
                      <td class="py-2 text-slate-400">${esc(k.tanggalJam)}</td>
                      <td class="py-2 font-semibold text-white">${esc(k.kategori)}</td>
                      <td class="py-2 text-slate-300">${esc(k.keterangan)}</td>
                      <td class="py-2 text-right font-mono-num font-bold ${k.jenis === 'Masuk' ? 'text-emerald-400' : k.jenis === 'Keluar' ? 'text-rose-400' : 'text-sky-400'}">${k.jenis === 'Keluar' ? '-' : (k.jenis === 'Transfer' ? '⇄ ' : '+')}${rp(k.nominal)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // BAB 13: RETUR PENJUALAN, RETUR PEMBELIAN & KOREKSI TRANSAKSI
  // ==========================================================================
  function renderReturView() {
    const canRetur = currentUser.akses.batal_retur_refund || currentUser.jabatan === 'Pemilik';
    const filteredRet = db.returKoreksi.filter((r) => isInDateFilter(r.tanggalJam));
    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div class="lg:col-span-5 glass-card rounded-2xl p-5 space-y-3">
          <h3 class="text-sm font-extrabold text-white border-b border-slate-800 pb-2">Catat Retur Penjualan / Pembelian</h3>
          ${!canRetur ? `<div class="p-3 rounded-xl bg-rose-950/50 border border-rose-500/30 text-xs text-rose-200">Akun Anda tidak memiliki izin Batal / Retur / Refund. Hubungi Pemilik atau Keuangan.</div>` : `
            <form onsubmit="window.AZI.submitRetur(event)" class="space-y-3 text-xs">
              <select id="ret-jenis" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                <option value="Retur Penjualan">Retur Penjualan Pelanggan</option>
                <option value="Retur Pembelian">Retur Pembelian ke Pemasok</option>
              </select>
              <input id="ret-noref" type="text" required placeholder="No. Transaksi Asal (mis: PJ-001 / PB-001) *" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
              <select id="ret-sku" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                ${db.barang.map((b) => `<option value="${esc(b.sku)}">${esc(b.sku)} — ${esc(b.nama)} (Stok: ${getStokAkhir(b)})</option>`).join('')}
              </select>
              <div class="grid grid-cols-2 gap-2">
                <input id="ret-qty" type="number" min="1" required value="1" placeholder="Jumlah Unit" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
                <select id="ret-layak" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                  <option value="YA">Kondisi Layak (Kembali ke Stok)</option>
                  <option value="TIDAK">Rusak (Tidak Masuk Stok Jual)</option>
                </select>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <select id="ret-metode" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                  <option value="Refund Kas">Refund Kas / Bank</option>
                  <option value="Potong Tagihan">Potong Piutang / Utang</option>
                </select>
                <input id="ret-nominal" type="number" min="0" required placeholder="Nominal (Rp) *" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
              </div>
              <select id="ret-akun" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                ${db.akunKas.map((a) => `<option value="${esc(a.id)}">Akun Kas/Bank (Jika Refund): ${esc(a.nama)}</option>`).join('')}
              </select>
              <input id="ret-alasan" type="text" required placeholder="Alasan Retur Wajib Diisi *" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
              <button type="submit" class="w-full py-3 rounded-xl btn-luxury text-xs uppercase">Proses Retur & Koreksi</button>
            </form>
          `}
        </div>

        <div class="lg:col-span-7 glass-card rounded-2xl p-5">
          <h3 class="text-sm font-extrabold text-white mb-3">Riwayat Retur & Jejak Koreksi</h3>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead>
                <tr class="border-b border-slate-800 text-slate-400">
                  <th class="py-2">Waktu</th>
                  <th class="py-2">Jenis & Ref Asal</th>
                  <th class="py-2">Barang</th>
                  <th class="py-2">Nilai & Penyelesaian</th>
                  <th class="py-2">Alasan & Petugas</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-800/60">
                ${filteredRet.length === 0 ? `<tr><td colspan="5" class="py-6 text-center text-slate-500">Belum ada catatan retur.</td></tr>` : filteredRet.map((r) => `
                  <tr>
                    <td class="py-2.5 text-slate-400">${esc(r.tanggalJam)}</td>
                    <td class="py-2.5 font-bold text-amber-300">${esc(r.jenis)} (${esc(r.noAsal)})</td>
                    <td class="py-2.5 text-white">${esc(r.sku)} &times; ${r.qty}</td>
                    <td class="py-2.5 font-mono-num">
                      <div class="text-rose-300 font-bold">${rp(r.nominalPenyelesaian !== undefined ? r.nominalPenyelesaian : r.nilaiOmzet)}</div>
                      <div class="text-[10px] text-slate-400">${esc(r.metodePenyelesaian || 'Refund Kas')}</div>
                    </td>
                    <td class="py-2.5 text-slate-300">${esc(r.alasan)} (${esc(r.petugas)})</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // BAB 12.C: LAPORAN LENGKAP & PEMISAHAN MODAL, SALDO, OMZET, DAN LABA
  // ==========================================================================
  function renderLaporanView() {
    const m = calculateFinancialMetrics();
    const akses = currentUser.akses;
    return `
      <div class="space-y-6">
        <div class="glass-card rounded-2xl p-6 space-y-5">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
            <div>
              <h3 class="text-base font-extrabold text-white">Laporan Keuangan, Persediaan & Laba Rugi Azi Cell</h3>
              <p class="text-xs text-slate-400">Saldo Kas, Nilai Persediaan, Modal Pemilik, Omzet Barang & Jasa, dan Laba dipisahkan secara ketat sesuai Bab 12.</p>
            </div>
            ${akses.ekspor_laporan ? `
              <button onclick="window.AZI.exportReportCsv()" class="px-4 py-2.5 rounded-xl btn-cyber text-xs">📥 Ekspor Laporan CSV Lengkap</button>
            ` : ''}
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
            <div class="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
              <div class="font-extrabold text-sky-400 uppercase">1. Rincian Omzet Bersih</div>
              <div class="flex justify-between"><span>Penjualan Barang:</span><b class="font-mono-num">${rp(m.omzetPenjualanBarang)}</b></div>
              <div class="flex justify-between text-sky-300"><span>Jasa Pasang (POS Kasir):</span><b class="font-mono-num">${rp(m.omzetJasaPenjualan)}</b></div>
              <div class="flex justify-between"><span>Pendapatan Jasa Servis:</span><b class="font-mono-num">${rp(m.omzetJasaServis)}</b></div>
              <div class="flex justify-between"><span>Spare Part Servis:</span><b class="font-mono-num">${rp(m.omzetSparepartServis)}</b></div>
              <div class="flex justify-between text-rose-400"><span>Retur Penjualan:</span><b class="font-mono-num">-${rp(m.totalReturOmzet)}</b></div>
              <div class="flex justify-between pt-2 border-t border-slate-800 text-sm font-extrabold text-white"><span>Total Omzet Bersih:</span><span class="font-mono-num">${rp(m.omzetBersih)}</span></div>
            </div>

            ${akses.lihat_laba ? `
              <div class="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
                <div class="font-extrabold text-amber-400 uppercase">2. Perhitungan Laba (Bab 12.B)</div>
                <div class="flex justify-between"><span>Omzet Bersih:</span><b class="font-mono-num">${rp(m.omzetBersih)}</b></div>
                <div class="flex justify-between text-rose-300"><span>HPP / Modal Barang Terjual:</span><b class="font-mono-num">-${rp(m.totalHpp)}</b></div>
                <div class="flex justify-between font-bold text-amber-300"><span>Laba Kotor:</span><b class="font-mono-num">${rp(m.labaKotor)}</b></div>
                <div class="flex justify-between text-rose-300"><span>Biaya Operasional Toko:</span><b class="font-mono-num">-${rp(m.biayaOperasional)}</b></div>
                <div class="flex justify-between pt-2 border-t border-slate-800 text-sm font-extrabold text-emerald-400"><span>Laba Bersih Operasional:</span><span class="font-mono-num">${rp(m.labaBersihOperasional)}</span></div>
              </div>
            ` : ''}

            <div class="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
              <div class="font-extrabold text-emerald-400 uppercase">3. Modal, Persediaan & Tagihan</div>
              ${akses.lihat_modal ? `<div class="flex justify-between"><span>Nilai Persediaan (Stok):</span><b class="font-mono-num">${rp(m.nilaiPersediaan)}</b></div>` : ''}
              <div class="flex justify-between"><span>Setoran Modal Pemilik:</span><b class="font-mono-num">${rp(m.modalDisetor)}</b></div>
              <div class="flex justify-between"><span>Penarikan Modal Pemilik:</span><b class="font-mono-num">${rp(m.modalDitarik)}</b></div>
              <div class="flex justify-between text-amber-300"><span>Total Piutang Pelanggan:</span><b class="font-mono-num">${rp(m.totalPiutang)}</b></div>
              <div class="flex justify-between text-rose-300"><span>Total Utang Pemasok:</span><b class="font-mono-num">${rp(m.totalUtang)}</b></div>
            </div>
          </div>
        </div>

        ${akses.kelola_karyawan ? `
          <div class="glass-card rounded-2xl p-5">
            <h4 class="text-sm font-extrabold text-white mb-3">Log Audit Aktivitas Sistem Terbaru (25 Terakhir)</h4>
            <div class="overflow-x-auto max-h-64">
              <table class="w-full text-left text-xs">
                <thead>
                  <tr class="border-b border-slate-800 text-slate-400">
                    <th class="py-2">Waktu</th>
                    <th class="py-2">Pelaku</th>
                    <th class="py-2">Aksi</th>
                    <th class="py-2">Target</th>
                    <th class="py-2">Detail</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-800/60">
                  ${db.logAudit.slice(0, 25).map((lg) => `
                    <tr>
                      <td class="py-1.5 text-slate-400 whitespace-nowrap">${esc(lg.waktu)}</td>
                      <td class="py-1.5 font-bold text-amber-300">${esc(lg.pelaku)}</td>
                      <td class="py-1.5 font-mono-num text-sky-300">${esc(lg.aksi)}</td>
                      <td class="py-1.5 text-white">${esc(lg.target)}</td>
                      <td class="py-1.5 text-slate-300">${esc(lg.detail)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  // ==========================================================================
  // BAB 04: TAMBAH KARYAWAN & ATUR HAK AKSES PER AKUN
  // ==========================================================================
  function renderKaryawanView() {
    if (!currentUser.akses.kelola_karyawan) {
      return `<div class="glass-card rounded-2xl p-6 text-xs text-rose-300">Akses ditolak: Hanya Pemilik yang dapat mengelola akun karyawan dan hak akses.</div>`;
    }
    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div class="lg:col-span-5 glass-card rounded-2xl p-5 space-y-3">
          <h3 class="text-sm font-extrabold text-white border-b border-slate-800 pb-2">Tambah / Update Akun Karyawan & Hak Akses</h3>
          <form onsubmit="window.AZI.submitKaryawan(event)" class="space-y-3 text-xs">
            <div class="grid grid-cols-2 gap-2">
              <input id="usr-nama" type="text" required placeholder="Nama Lengkap *" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
              <input id="usr-username" type="text" required placeholder="Username Unik *" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
            </div>
            <div class="grid grid-cols-2 gap-2">
              <input id="usr-kontak" type="text" placeholder="No. WA / Kontak" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
              <input id="usr-pass" type="text" required value="123" placeholder="Password Sementara *" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-amber-300 font-mono-num" />
            </div>
            <select id="usr-jabatan" onchange="window.AZI.applyRolePreset(this.value)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
              <option value="Kasir">Profil: Kasir</option>
              <option value="Teknisi">Profil: Teknisi</option>
              <option value="Gudang">Profil: Gudang</option>
              <option value="Keuangan">Profil: Keuangan</option>
              <option value="Pemilik">Profil: Pemilik</option>
            </select>
            <label class="flex items-center gap-2 text-slate-300">
              <input id="usr-force-change" type="checkbox" checked class="rounded" />
              <span>Wajib ganti password saat login pertama</span>
            </label>

            <div class="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
              <div class="font-bold text-amber-400">Izin Menu yang Boleh Dibuka:</div>
              <div class="grid grid-cols-2 gap-1.5">
                ${MENU_META.map((m) => `
                  <label class="flex items-center gap-1.5 text-[11px] text-slate-200">
                    <input type="checkbox" name="usr-menu" value="${m.id}" ${ROLE_PRESETS.Kasir.menus.includes(m.id) ? 'checked' : ''} />
                    <span>${m.label}</span>
                  </label>
                `).join('')}
              </div>
            </div>

            <div class="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-1.5">
              <div class="font-bold text-sky-400">Izin Tindakan Spesifik:</div>
              <label class="flex items-center gap-2"><input id="perm-modal" type="checkbox" /><span>Lihat Harga Modal & HPP</span></label>
              <label class="flex items-center gap-2"><input id="perm-diskon" type="checkbox" /><span>Ubah Harga Jual & Beri Diskon</span></label>
              <label class="flex items-center gap-2"><input id="perm-laba" type="checkbox" /><span>Lihat Laporan Laba Kotor & Bersih</span></label>
              <label class="flex items-center gap-2"><input id="perm-semua" type="checkbox" checked /><span>Lihat Transaksi Seluruh Toko</span></label>
              <label class="flex items-center gap-2"><input id="perm-retur" type="checkbox" /><span>Batal / Retur / Refund</span></label>
              <label class="flex items-center gap-2"><input id="perm-cetak" type="checkbox" checked /><span>Cetak / Cetak Ulang Nota</span></label>
              <label class="flex items-center gap-2"><input id="perm-ekspor" type="checkbox" /><span>Ekspor Laporan CSV</span></label>
              <label class="flex items-center gap-2"><input id="perm-karyawan" type="checkbox" /><span>Kelola Akun Karyawan (Khusus Pemilik)</span></label>
            </div>

            <button type="submit" class="w-full py-3 rounded-xl btn-luxury text-xs uppercase">Simpan Akun & Hak Akses</button>
          </form>
        </div>

        <div class="lg:col-span-7 glass-card rounded-2xl p-5 space-y-4">
          <h3 class="text-sm font-extrabold text-white">Daftar Akun Karyawan & Kontrol Sesi</h3>
          <div class="space-y-2.5">
            ${db.karyawan.map((u) => `
              <div class="p-3.5 rounded-xl bg-slate-900 border border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div>
                  <div class="font-bold text-white">${esc(u.nama)} <span class="text-amber-400 font-mono-num">(@${esc(u.username)})</span></div>
                  <div class="text-[11px] text-slate-400">Jabatan: ${esc(u.jabatan)} • Kontak: ${esc(u.kontak || '-')}</div>
                  <div class="text-[10px] text-slate-500">Menu: ${esc((u.akses && u.akses.menus ? u.akses.menus : []).join(', '))}</div>
                </div>
                <div class="flex flex-wrap items-center gap-1.5">
                  <button onclick="window.AZI.editKaryawan('${esc(u.username)}')" class="px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 font-bold text-[11px]">Edit</button>
                  <button onclick="window.AZI.resetUserPassword('${esc(u.username)}')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 font-bold text-[11px]">Reset Sandi</button>
                  <button onclick="window.AZI.toggleUserActive('${esc(u.username)}')" class="px-2.5 py-1 rounded-lg ${u.aktif ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'} font-bold text-[11px]">
                    ${u.aktif ? 'Aktif (Nonaktifkan?)' : 'Nonaktif (Aktifkan?)'}
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // BAB 03 & BAB 11: PENGATURAN TOKO, PRINTER THERMAL & SERAH TERIMA SPREADSHEET PEMILIK
  // ==========================================================================
  function renderPengaturanView() {
    const isBtConn = bluetoothStatus === 'connected' && Boolean(bluetoothCharacteristic);
    const hasGas = Boolean((db.config.gasWebAppUrl || '').trim());
    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- SERAH TERIMA SPREADSHEET PEMILIK (WAJIB DIGANTI KE PEMILIK) -->
        <div class="lg:col-span-6 space-y-5">
          <div class="glass-card rounded-2xl p-5 space-y-4 border border-amber-500/40">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                ⚠️ WAJIB DIGANTI SAAT SERAH TERIMA KE PEMILIK
              </span>
              <span class="px-2.5 py-1 rounded-full text-[10px] font-bold ${hasGas ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}">
                ${hasGas ? (cloudSyncState.lastSyncedAt ? `Sync: ${cloudSyncState.lastSyncedAt}` : 'URL Web App Terpasang') : 'URL Web App Belum Diisi'}
              </span>
            </div>
            <h3 class="text-sm font-extrabold text-white">Koneksi Google Spreadsheet Pemilik & Sinkronisasi 12 Sheet</h3>
            <p class="text-xs text-slate-300">
              Tempel <b>Link / ID Google Spreadsheet</b> dan <b>URL Web App Google Apps Script (Code.gs v1.0.2)</b> di bawah ini untuk menyinkronkan seluruh 12 Sheet secara otomatis & dua arah.
            </p>
            <form onsubmit="window.AZI.saveOwnerDatabaseConfig(event)" class="space-y-3 text-xs">
              <div>
                <label class="block text-[10px] text-amber-300 font-bold mb-1">Link / ID Google Spreadsheet Pemilik Toko *</label>
                <input id="cfg-sheet-url" type="text" required value="${esc(db.config.spreadsheetUrl)}" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-amber-500/40 text-white font-mono-num" />
              </div>
              <div>
                <label class="block text-[10px] text-sky-300 font-bold mb-1">URL Web App Google Apps Script (Deploy Code.gs) *</label>
                <input id="cfg-gas-url" type="text" value="${esc(db.config.gasWebAppUrl)}" placeholder="https://script.google.com/macros/s/.../exec" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-sky-500/40 text-white font-mono-num" />
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                <button type="submit" class="py-2.5 rounded-xl btn-luxury text-xs">Simpan Konfigurasi Cloud</button>
                <button type="button" onclick="window.AZI.triggerRemoteSheetSetup()" class="py-2.5 rounded-xl btn-cyber text-xs">⚡ Setup 12 Sheet & Header</button>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button type="button" onclick="window.AZI.pushAllToSheets()" class="py-2.5 rounded-xl bg-emerald-600/25 hover:bg-emerald-600/35 border border-emerald-500/40 text-emerald-300 font-bold text-xs">☁️ Kirim Semua Data (Push)</button>
                <button type="button" onclick="window.AZI.pullFromGoogleSheets()" class="py-2.5 rounded-xl bg-indigo-600/25 hover:bg-indigo-600/35 border border-indigo-500/40 text-indigo-200 font-bold text-xs">📥 Tarik Data Cloud (Pull)</button>
              </div>
            </form>
          </div>

          <!-- BACKUP & RESTORE LOKAL JSON -->
          <div class="glass-card rounded-2xl p-5 space-y-3 text-xs">
            <h3 class="text-sm font-extrabold text-white">Cadangkan & Pulihkan Data Lokal (JSON)</h3>
            <p class="text-slate-400">Simpan cadangan file JSON sebelum pindah perangkat atau lakukan pemulihan data secara instan.</p>
            <div class="flex flex-wrap gap-2">
              <button type="button" onclick="window.AZI.exportBackupJson()" class="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-amber-300 font-bold">💾 Unduh Backup JSON</button>
              <label class="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-sky-500/40 text-sky-300 font-bold cursor-pointer">
                📂 Pulihkan dari JSON
                <input type="file" accept=".json,application/json" onchange="window.AZI.importBackupJson(event)" class="hidden" />
              </label>
            </div>
          </div>
        </div>

        <!-- PROFIL TOKO & PRINTER THERMAL BLUETOOTH (BAB 11) -->
        <div class="lg:col-span-6 space-y-5">
          <div class="glass-card rounded-2xl p-5 space-y-3">
            <h3 class="text-sm font-extrabold text-white">Pengaturan Profil Toko, Footer Nota & Printer Thermal</h3>
            <form onsubmit="window.AZI.saveStoreProfile(event)" class="space-y-2.5 text-xs">
              <div class="grid grid-cols-2 gap-2">
                <input id="cfg-nama" type="text" required value="${esc(db.config.namaToko)}" placeholder="Nama Toko" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
                <input id="cfg-kontak" type="text" required value="${esc(db.config.kontak)}" placeholder="Kontak / WA" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
              </div>
              <input id="cfg-tagline" type="text" value="${esc(db.config.tagline || '')}" placeholder="Tagline Toko" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
              <input id="cfg-alamat" type="text" required value="${esc(db.config.alamat)}" placeholder="Alamat Lengkap Nota" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
              <div>
                <label class="block text-[10px] text-slate-400 mb-1">Footer / Catatan Garansi di Bawah Struk Nota</label>
                <textarea id="cfg-footer" rows="2" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">${esc(db.config.footerNota || '')}</textarea>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <select id="cfg-printer" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                  <option value="58mm" ${db.config.lebarPrinter === '58mm' ? 'selected' : ''}>Lebar Kertas Thermal 58 mm</option>
                  <option value="80mm" ${db.config.lebarPrinter === '80mm' ? 'selected' : ''}>Lebar Kertas Thermal 80 mm</option>
                </select>
                <button type="submit" class="py-2 rounded-xl btn-luxury text-xs">Simpan Profil & Nota</button>
              </div>
            </form>

            <!-- PANEL KONTROL BLUETOOTH PRINTER -->
            <div class="pt-3 border-t border-slate-800 space-y-3">
              <div class="p-3 rounded-xl border ${isBtConn ? 'bg-emerald-950/40 border-emerald-500/40' : 'bg-rose-950/35 border-rose-500/40'} flex items-center justify-between gap-2 text-xs">
                <div class="flex items-center gap-2">
                  <span class="w-3 h-3 rounded-full ${isBtConn ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}"></span>
                  <div>
                    <div class="font-bold ${isBtConn ? 'text-emerald-300' : 'text-rose-200'}">
                      Status Printer Bluetooth: ${isBtConn ? `TERHUBUNG (${esc(bluetoothDeviceName || 'Thermal')})` : 'BELUM TERHUBUNG'}
                    </div>
                    <div class="text-[10px] text-slate-400">Anda juga bisa klik tombol Bluetooth di pojok kanan atas kapan saja.</div>
                  </div>
                </div>
              </div>
              <div class="flex flex-wrap gap-2">
                <button type="button" onclick="window.AZI.connectBluetoothPrinter()" class="px-3.5 py-2 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/40 text-sky-300 font-bold text-xs">
                  🖨️ ${isBtConn ? 'Ganti Printer Bluetooth' : 'Hubungkan Printer Bluetooth'}
                </button>
                ${isBtConn ? `
                  <button type="button" onclick="window.AZI.disconnectBluetoothPrinter()" class="px-3.5 py-2 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 font-bold text-xs">
                    🔌 Putuskan Koneksi
                  </button>
                ` : ''}
                <button type="button" onclick="window.AZI.testPrintThermal()" class="px-3.5 py-2 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 font-bold text-xs">
                  🧾 Tes Cetak Struk (${esc(db.config.lebarPrinter)})
                </button>
              </div>
            </div>
          </div>

          <!-- KELOLA AKUN KAS & SALDO AWAL -->
          <div class="glass-card rounded-2xl p-5 space-y-3 text-xs">
            <h3 class="text-sm font-extrabold text-white">Kelola Akun Kas / Bank / E-Wallet</h3>
            <div class="space-y-2">
              ${db.akunKas.map((a) => `
                <div class="p-2.5 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between gap-2">
                  <div>
                    <div class="font-bold text-white">${esc(a.nama)} <span class="text-[10px] text-sky-400">(${esc(a.tipe)})</span></div>
                    <div class="text-[10px] text-slate-400">ID: ${esc(a.id)} • Saldo Awal: <b class="font-mono-num text-emerald-300">${rp(a.saldoAwal)}</b></div>
                  </div>
                  <button type="button" onclick="window.AZI.editAkunKas('${esc(a.id)}')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 font-bold text-[10px]">Edit</button>
                </div>
              `).join('')}
            </div>
            <form onsubmit="window.AZI.submitAkunKas(event)" class="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800">
              <input id="acc-id" type="hidden" value="" />
              <input id="acc-nama" type="text" required placeholder="Nama Akun (mis: Bank BRI / DANA)" class="col-span-2 px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
              <select id="acc-tipe" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                <option value="Tunai">Tunai</option>
                <option value="Transfer">Transfer Bank</option>
                <option value="QRIS">QRIS / E-Wallet</option>
              </select>
              <input id="acc-saldo" type="number" min="0" required value="0" placeholder="Saldo Awal (Rp)" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-emerald-300 font-mono-num" />
              <button type="submit" class="col-span-2 py-2 rounded-xl btn-cyber text-xs">Simpan / Tambah Akun Kas</button>
            </form>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // ESC/POS THERMAL RECEIPT FORMATTER (PRESISI 58mm=32 KARAKTER / 80mm=48 KARAKTER)
  // ==========================================================================
  function buildEscPosReceipt(opts) {
    const width = db.config.lebarPrinter === '80mm' ? 48 : 32;
    const hr = '-'.repeat(width);
    const eq = '='.repeat(width);
    const clean = (s) => String(s === null || s === undefined ? '' : s).replace(/[^\x20-\x7E\n]/g, ' ');
    const wrapLine = (text, maxW) => {
      const str = clean(text);
      if (str.length <= maxW) return [str];
      const out = [];
      let cur = '';
      str.split(' ').forEach((word) => {
        if (!cur) cur = word;
        else if ((cur + ' ' + word).length <= maxW) cur += ' ' + word;
        else { out.push(cur); cur = word; }
      });
      if (cur) out.push(cur);
      return out.length ? out : [''];
    };
    const rowLR = (left, right) => {
      const l = clean(left);
      const r = clean(right);
      const space = width - l.length - r.length;
      if (space >= 1) return l + ' '.repeat(space) + r;
      const trimmedL = l.slice(0, Math.max(1, width - r.length - 1));
      return trimmedL + ' ' + r;
    };

    const INIT = '\x1B\x40';
    const ALIGN_LEFT = '\x1B\x61\x00';
    const ALIGN_CENTER = '\x1B\x61\x01';
    const BOLD_ON = '\x1B\x45\x01';
    const BOLD_OFF = '\x1B\x45\x00';

    let out = INIT;
    out += ALIGN_CENTER + BOLD_ON + clean(db.config.namaToko) + '\n' + BOLD_OFF;
    wrapLine(db.config.alamat, width).forEach((ln) => { out += ln + '\n'; });
    out += clean('Telp/WA: ' + db.config.kontak) + '\n';
    out += BOLD_ON + clean(opts.title) + '\n' + BOLD_OFF;
    out += ALIGN_LEFT + hr + '\n';

    (opts.metaLines || []).forEach((ln) => {
      wrapLine(ln, width).forEach((w) => { out += w + '\n'; });
    });
    out += hr + '\n';

    (opts.sections || []).forEach((sec) => {
      if (sec.heading) out += BOLD_ON + clean(sec.heading) + '\n' + BOLD_OFF;
      (sec.lines || []).forEach((item) => {
        if (typeof item === 'string') {
          wrapLine(item, width).forEach((w) => { out += w + '\n'; });
        } else if (item.lr) {
          out += rowLR(item.left, item.right) + '\n';
        } else {
          wrapLine(item.name, width).forEach((w) => { out += w + '\n'; });
          if (item.detailLeft || item.detailRight) {
            out += rowLR('  ' + (item.detailLeft || ''), item.detailRight || '') + '\n';
          }
        }
      });
    });

    out += hr + '\n';
    (opts.summaryRows || []).forEach((r) => {
      if (r.bold) out += BOLD_ON + rowLR(r.left, r.right) + '\n' + BOLD_OFF;
      else out += rowLR(r.left, r.right) + '\n';
    });
    out += eq + '\n';
    out += BOLD_ON + rowLR('STATUS BAYAR', String(opts.statusBayar || '').toUpperCase()) + '\n' + BOLD_OFF;
    out += hr + '\n';
    out += ALIGN_CENTER;
    String(db.config.footerNota || '').split('\n').forEach((line) => {
      wrapLine(line, width).forEach((w) => { out += w + '\n'; });
    });
    out += ALIGN_LEFT + '\n\n\n';
    return out;
  }

  // ==========================================================================
  // BAB 10 & 11: PRATINJAU NOTA / INVOICE (BARANG + JASA PASANG & SERVIS)
  // ==========================================================================
  function openReceiptModal(docType, refNo) {
    let title = 'NOTA TRANSAKSI';
    let itemsHtml = '';
    let summaryHtml = '';
    let pelanggan = '-';
    let tanggal = nowStr();
    let petugas = currentUser.nama;
    let statusBayar = 'Lunas';
    let extraMetaHtml = '';
    let blePayload = '';
    let waPhone = '';
    let waText = '';

    if (docType === 'PENJUALAN') {
      const p = db.penjualan.find((x) => x.no === refNo);
      if (!p) return;
      const items = Array.isArray(p.items) ? p.items : [];
      const jasaItems = Array.isArray(p.jasaItems) ? p.jasaItems : [];
      const totalBarang = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.hargaJual) || 0), 0);
      const totalJasa = jasaItems.reduce((s, j) => s + (Number(j.biaya) || 0), 0);

      // Validasi harga wajib ada sebelum cetak (Bab 10)
      for (const it of items) {
        if (!it.nama || !it.qty || it.hargaJual === '' || it.hargaJual === null || it.hargaJual === undefined || Number(it.hargaJual) < 0) {
          showToast('Cetak ditolak: Ada baris barang yang belum memiliki harga satuan valid!', 'error');
          return;
        }
      }
      for (const j of jasaItems) {
        if (!j.nama || j.biaya === '' || j.biaya === null || j.biaya === undefined || Number(j.biaya) < 0) {
          showToast('Cetak ditolak: Ada baris jasa yang nama atau biayanya tidak valid!', 'error');
          return;
        }
      }

      title = p.statusBayar === 'Lunas' ? 'NOTA PENJUALAN (LUNAS)' : 'INVOICE TAGIHAN PENJUALAN';
      pelanggan = p.kontak && p.kontak !== '-' ? `${p.pelanggan} (${p.kontak})` : p.pelanggan;
      tanggal = p.tanggalJam;
      petugas = p.petugas;
      statusBayar = p.statusBayar;
      if (p.catatan) extraMetaHtml = `<div>Catatan: ${esc(p.catatan)}</div>`;

      const barangHtml = items.length > 0 ? `
        ${jasaItems.length > 0 ? `<div class="font-bold underline mb-1">Rincian Barang:</div>` : ''}
        ${items.map((i) => `
          <div class="py-0.5">
            <div class="font-semibold">${esc(i.nama)}</div>
            <div class="flex justify-between pl-2">
              <span>${i.qty} x ${rp(i.hargaJual)}</span>
              <span>${rp(i.qty * i.hargaJual)}</span>
            </div>
          </div>
        `).join('')}
      ` : '';

      const jasaHtml = jasaItems.length > 0 ? `
        <div class="font-bold underline ${items.length > 0 ? 'mt-2' : ''} mb-1">Rincian Jasa / Ongkos Pasang:</div>
        ${jasaItems.map((j) => `
          <div class="flex justify-between py-0.5">
            <span>${esc(j.nama)}</span>
            <span>${rp(j.biaya)}</span>
          </div>
        `).join('')}
      ` : '';

      itemsHtml = barangHtml + jasaHtml;

      summaryHtml = `
        ${(items.length > 0 && jasaItems.length > 0) ? `
          <div class="flex justify-between"><span>Subtotal Barang:</span><span>${rp(totalBarang)}</span></div>
          <div class="flex justify-between"><span>Total Jasa / Pasang:</span><span>${rp(totalJasa)}</span></div>
        ` : ''}
        <div class="flex justify-between"><span>Subtotal:</span><span>${rp(p.subtotal)}</span></div>
        ${p.diskon > 0 ? `<div class="flex justify-between"><span>Diskon:</span><span>-${rp(p.diskon)}</span></div>` : ''}
        <div class="flex justify-between font-bold text-sm"><span>TOTAL:</span><span>${rp(p.totalAkhir)}</span></div>
        <div class="flex justify-between"><span>Uang Diterima (${esc(p.metodeBayar)}):</span><span>${rp(p.uangDiterima)}</span></div>
        ${p.kembalian > 0 ? `<div class="flex justify-between"><span>Kembalian:</span><span>${rp(p.kembalian)}</span></div>` : ''}
        ${p.sisaPiutang > 0 ? `<div class="flex justify-between font-bold"><span>Sisa Tagihan:</span><span>${rp(p.sisaPiutang)}</span></div>` : ''}
      `;

      const bleSections = [];
      if (items.length > 0) {
        bleSections.push({
          heading: jasaItems.length > 0 ? 'RINCIAN BARANG:' : '',
          lines: items.map((i) => ({
            name: i.nama,
            detailLeft: `${i.qty} x ${rp(i.hargaJual)}`,
            detailRight: rp(i.qty * i.hargaJual)
          }))
        });
      }
      if (jasaItems.length > 0) {
        bleSections.push({
          heading: 'RINCIAN JASA / PASANG:',
          lines: jasaItems.map((j) => ({ lr: true, left: j.nama, right: rp(j.biaya) }))
        });
      }
      const bleSummary = [];
      if (items.length > 0 && jasaItems.length > 0) {
        bleSummary.push({ left: 'Subtotal Barang', right: rp(totalBarang) });
        bleSummary.push({ left: 'Total Jasa/Pasang', right: rp(totalJasa) });
      }
      bleSummary.push({ left: 'Subtotal', right: rp(p.subtotal) });
      if (p.diskon > 0) bleSummary.push({ left: 'Diskon', right: '-' + rp(p.diskon) });
      bleSummary.push({ left: 'TOTAL', right: rp(p.totalAkhir), bold: true });
      bleSummary.push({ left: `Bayar (${p.metodeBayar})`, right: rp(p.uangDiterima) });
      if (p.kembalian > 0) bleSummary.push({ left: 'Kembalian', right: rp(p.kembalian) });
      if (p.sisaPiutang > 0) bleSummary.push({ left: 'Sisa Tagihan', right: rp(p.sisaPiutang), bold: true });

      const metaLines = [
        `No       : ${p.no}`,
        `Waktu    : ${tanggal}`,
        `Petugas  : ${petugas}`,
        `Pelanggan: ${pelanggan}`
      ];
      if (p.catatan) metaLines.push(`Catatan  : ${p.catatan}`);

      blePayload = buildEscPosReceipt({ title, metaLines, sections: bleSections, summaryRows: bleSummary, statusBayar });
      waPhone = p.kontak && p.kontak !== '-' ? p.kontak : '';
      waText = `*${db.config.namaToko}*\n${title}\nNo: ${p.no} | ${tanggal}\nPelanggan: ${p.pelanggan}\n` +
        (items.length ? `\n*Rincian Barang:*\n` + items.map((i) => `• ${i.nama} (${i.qty}x ${rp(i.hargaJual)}) = ${rp(i.qty * i.hargaJual)}`).join('\n') : '') +
        (jasaItems.length ? `\n\n*Rincian Jasa / Pasang:*\n` + jasaItems.map((j) => `• ${j.nama} = ${rp(j.biaya)}`).join('\n') : '') +
        `\n\n*TOTAL: ${rp(p.totalAkhir)}*\nBayar (${p.metodeBayar}): ${rp(p.uangDiterima)}` +
        (p.kembalian > 0 ? `\nKembalian: ${rp(p.kembalian)}` : '') +
        (p.sisaPiutang > 0 ? `\nSisa Tagihan: ${rp(p.sisaPiutang)}` : '') +
        `\nStatus: *${statusBayar.toUpperCase()}*\n\n${db.config.footerNota}`;
    } else if (docType === 'SERVIS_TERIMA') {
      const s = db.servis.find((x) => x.no === refNo);
      if (!s) return;
      title = 'TANDA TERIMA SERVIS (BUKAN NOTA FINAL)';
      pelanggan = `${s.pelanggan} (${s.kontak})`;
      tanggal = s.tanggalTerima;
      petugas = s.petugasTerima;
      statusBayar = s.statusBayar;
      itemsHtml = `
        <div>Perangkat: <b>${esc(s.perangkat)} — ${esc(s.merekModel)}</b></div>
        <div>Jenis Servis: <b>${esc(s.jenisServis)}</b></div>
        <div>Keluhan: ${esc(s.keluhan)}</div>
        <div>Kelengkapan: ${esc(s.kelengkapan || '-')}</div>
      `;
      summaryHtml = `
        <div class="flex justify-between"><span>Perkiraan Biaya:</span><span>${rp(s.estimasiBiaya)}</span></div>
        <div class="flex justify-between"><span>DP Diterima:</span><span>${rp(s.dpAwal)}</span></div>
      `;
      blePayload = buildEscPosReceipt({
        title: 'TANDA TERIMA SERVIS',
        metaLines: [
          `No       : ${s.no}`,
          `Waktu    : ${tanggal}`,
          `Petugas  : ${petugas}`,
          `Pelanggan: ${s.pelanggan}`,
          `Kontak   : ${s.kontak}`
        ],
        sections: [{
          heading: 'DATA PERANGKAT:',
          lines: [
            `Unit       : ${s.perangkat} ${s.merekModel}`,
            `Servis     : ${s.jenisServis}`,
            `Keluhan    : ${s.keluhan}`,
            `Kelengkapan: ${s.kelengkapan || '-'}`
          ]
        }],
        summaryRows: [
          { left: 'Perkiraan Biaya', right: rp(s.estimasiBiaya) },
          { left: 'DP Diterima', right: rp(s.dpAwal), bold: true }
        ],
        statusBayar: s.statusBayar
      });
      waPhone = s.kontak || '';
      waText = `*${db.config.namaToko}*\nTANDA TERIMA SERVIS\nNo: ${s.no} | ${tanggal}\nPelanggan: ${s.pelanggan}\nPerangkat: ${s.perangkat} ${s.merekModel}\nJenis Servis: ${s.jenisServis}\nKeluhan: ${s.keluhan}\nKelengkapan: ${s.kelengkapan || '-'}\nPerkiraan Biaya: ${rp(s.estimasiBiaya)}\nDP Diterima: ${rp(s.dpAwal)}\n\n${db.config.footerNota}`;
    } else if (docType === 'SERVIS_FINAL') {
      const s = db.servis.find((x) => x.no === refNo);
      if (!s) return;
      const jasaList = (Array.isArray(s.jasaItems) && s.jasaItems.length > 0)
        ? s.jasaItems
        : (s.namaJasa ? [{ nama: s.namaJasa, biaya: Number(s.biayaJasa) || 0 }] : []);

      // Validasi Harga Sparepart & Biaya Jasa (Biaya jasa Rp0 sengaja diperbolehkan, tapi tidak boleh kosong - Bab 10)
      if (jasaList.length === 0 || jasaList.some((j) => !j.nama || j.biaya === '' || j.biaya === null || j.biaya === undefined || Number(j.biaya) < 0)) {
        showToast('Cetak ditolak: Nama tindakan jasa dan Biaya Jasa wajib diisi (isi 0 jika gratis)!', 'error');
        return;
      }

      title = s.statusBayar === 'Lunas' ? 'NOTA SERVIS (LUNAS)' : 'INVOICE TAGIHAN SERVIS';
      pelanggan = `${s.pelanggan} (${s.kontak})`;
      tanggal = s.tanggalSelesai || s.tanggalTerima;
      petugas = s.teknisi || s.petugasTerima;
      statusBayar = s.statusBayar;
      extraMetaHtml = `
        <div>Unit: <b>${esc(s.merekModel)}</b> (${esc(s.jenisServis)})</div>
        ${s.tindakan ? `<div>Tindakan: ${esc(s.tindakan)}</div>` : ''}
      `;

      itemsHtml = `
        <div class="font-bold underline mb-1">Rincian Spare Part:</div>
        ${s.spareparts.length === 0 ? `<div class="pl-1">- Tanpa penggantian spare part</div>` : s.spareparts.map((sp) => `
          <div class="py-0.5">
            <div class="font-semibold">${esc(sp.nama)}</div>
            <div class="flex justify-between pl-2">
              <span>${sp.qty} x ${rp(sp.hargaJual)}</span>
              <span>${rp(sp.qty * sp.hargaJual)}</span>
            </div>
          </div>
        `).join('')}
        <div class="font-bold underline mt-2 mb-1">Rincian Biaya Jasa Servis:</div>
        ${jasaList.map((j) => `
          <div class="flex justify-between py-0.5">
            <span>${esc(j.nama)}</span>
            <span>${rp(j.biaya)}</span>
          </div>
        `).join('')}
      `;

      const lebihBayarDp = Math.max(0, (Number(s.totalTerbayar) || 0) - (Number(s.totalBiayaFinal) || 0));
      summaryHtml = `
        <div class="flex justify-between"><span>Total Spare Part:</span><span>${rp(s.totalSparepart)}</span></div>
        <div class="flex justify-between"><span>Total Biaya Jasa:</span><span>${rp(s.biayaJasa)}</span></div>
        ${Number(s.diskon) > 0 ? `<div class="flex justify-between"><span>Diskon:</span><span>-${rp(s.diskon)}</span></div>` : ''}
        <div class="flex justify-between font-bold text-sm"><span>TOTAL BIAYA:</span><span>${rp(s.totalBiayaFinal)}</span></div>
        <div class="flex justify-between"><span>Sudah Dibayar / DP:</span><span>${rp(s.totalTerbayar)}</span></div>
        ${lebihBayarDp > 0 ? `<div class="flex justify-between font-bold"><span>Kembalian DP:</span><span>${rp(lebihBayarDp)}</span></div>` : ''}
        <div class="flex justify-between font-bold"><span>Sisa Tagihan:</span><span>${rp(s.sisaTagihan)}</span></div>
      `;

      const bleSections = [
        {
          heading: 'RINCIAN SPARE PART:',
          lines: s.spareparts.length === 0
            ? ['- Tanpa spare part']
            : s.spareparts.map((sp) => ({
                name: sp.nama,
                detailLeft: `${sp.qty} x ${rp(sp.hargaJual)}`,
                detailRight: rp(sp.qty * sp.hargaJual)
              }))
        },
        {
          heading: 'RINCIAN JASA SERVIS:',
          lines: jasaList.map((j) => ({ lr: true, left: j.nama, right: rp(j.biaya) }))
        }
      ];
      const bleSummary = [
        { left: 'Total Spare Part', right: rp(s.totalSparepart) },
        { left: 'Total Biaya Jasa', right: rp(s.biayaJasa) }
      ];
      if (Number(s.diskon) > 0) bleSummary.push({ left: 'Diskon', right: '-' + rp(s.diskon) });
      bleSummary.push({ left: 'TOTAL BIAYA', right: rp(s.totalBiayaFinal), bold: true });
      bleSummary.push({ left: 'Sudah Bayar / DP', right: rp(s.totalTerbayar) });
      if (lebihBayarDp > 0) bleSummary.push({ left: 'Kembalian DP', right: rp(lebihBayarDp), bold: true });
      bleSummary.push({ left: 'Sisa Tagihan', right: rp(s.sisaTagihan), bold: true });

      const metaLines = [
        `No       : ${s.no}`,
        `Waktu    : ${tanggal}`,
        `Teknisi  : ${petugas}`,
        `Pelanggan: ${s.pelanggan}`,
        `Kontak   : ${s.kontak}`,
        `Unit     : ${s.merekModel}`,
        `Servis   : ${s.jenisServis}`
      ];
      if (s.tindakan) metaLines.push(`Tindakan : ${s.tindakan}`);

      blePayload = buildEscPosReceipt({ title, metaLines, sections: bleSections, summaryRows: bleSummary, statusBayar });
      waPhone = s.kontak || '';
      waText = `*${db.config.namaToko}*\n${title}\nNo: ${s.no} | ${tanggal}\nPelanggan: ${s.pelanggan}\nUnit: ${s.merekModel} (${s.jenisServis})\n` +
        (s.tindakan ? `Tindakan: ${s.tindakan}\n` : '') +
        `\n*Rincian Spare Part:*\n` +
        (s.spareparts.length ? s.spareparts.map((sp) => `• ${sp.nama} (${sp.qty}x ${rp(sp.hargaJual)}) = ${rp(sp.qty * sp.hargaJual)}`).join('\n') : '- Tanpa spare part') +
        `\n\n*Rincian Biaya Jasa Servis:*\n` +
        jasaList.map((j) => `• ${j.nama} = ${rp(j.biaya)}`).join('\n') +
        `\n\n*TOTAL BIAYA: ${rp(s.totalBiayaFinal)}*\nSudah Bayar/DP: ${rp(s.totalTerbayar)}\nSisa Tagihan: ${rp(s.sisaTagihan)}\nStatus: *${statusBayar.toUpperCase()}*\n\n${db.config.footerNota}`;
    }

    lastReceiptBlePayload = blePayload;
    const cleanWaDigits = String(waPhone || '').replace(/\D/g, '').replace(/^0/, '62');
    const waShareUrl = `https://wa.me/${cleanWaDigits}?text=${encodeURIComponent(waText)}`;
    const paperClass = db.config.lebarPrinter === '80mm' ? 'receipt-80mm' : 'receipt-58mm';
    const isBtConn = bluetoothStatus === 'connected' && Boolean(bluetoothCharacteristic);

    openModal(`
      <div class="glass-card rounded-2xl p-6 max-w-lg w-full space-y-4">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h3 class="text-sm font-extrabold text-white">Pratinjau Cetak (${esc(db.config.lebarPrinter)})</h3>
            <p class="text-[10px] ${isBtConn ? 'text-emerald-400' : 'text-rose-400'}">
              Bluetooth: ${isBtConn ? `Terhubung (${esc(bluetoothDeviceName || 'Thermal')})` : 'Belum Konek (Merah)'}
            </p>
          </div>
          <button onclick="window.AZI.closeModal()" class="text-slate-400 hover:text-white text-xl">&times;</button>
        </div>

        <!-- AREA KERTAS STRUK THERMAL -->
        <div class="flex justify-center bg-slate-950 p-4 rounded-xl overflow-x-auto">
          <div id="thermal-print-area" class="${paperClass} bg-white text-black p-4 rounded shadow-xl">
            <div class="text-center border-b border-dashed border-black pb-2 mb-2">
              <div class="font-extrabold text-sm">${esc(db.config.namaToko)}</div>
              <div>${esc(db.config.alamat)}</div>
              <div>Telp/WA: ${esc(db.config.kontak)}</div>
              <div class="font-bold mt-1">${esc(title)}</div>
            </div>
            <div class="border-b border-dashed border-black pb-2 mb-2">
              <div>No: <b>${esc(refNo)}</b></div>
              <div>Waktu: ${esc(tanggal)}</div>
              <div>Petugas: ${esc(petugas)}</div>
              <div>Pelanggan: ${esc(pelanggan)}</div>
              ${extraMetaHtml}
            </div>
            <div class="border-b border-dashed border-black pb-2 mb-2">
              ${itemsHtml}
            </div>
            <div class="border-b border-dashed border-black pb-2 mb-2 space-y-0.5">
              ${summaryHtml}
              <div class="flex justify-between font-extrabold pt-1"><span>STATUS BAYAR:</span><span>${esc(statusBayar.toUpperCase())}</span></div>
            </div>
            <div class="text-center text-[10px] whitespace-pre-line">${esc(db.config.footerNota)}</div>
          </div>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <button id="modal-ble-print-btn" onclick="window.AZI.printCurrentReceiptBluetooth()" class="col-span-2 sm:col-span-2 py-2.5 px-3 rounded-xl ${isBtConn ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-rose-600/80 hover:bg-rose-600'} text-white font-bold text-xs flex items-center justify-center gap-1.5">
            <span>🖨️</span><span>${isBtConn ? 'Cetak Bluetooth (Siap)' : 'Konek & Cetak Bluetooth'}</span>
          </button>
          <button onclick="window.print()" class="py-2.5 px-3 rounded-xl btn-luxury text-xs">
            📄 Cetak / PDF
          </button>
          <a href="${esc(waShareUrl)}" target="_blank" rel="noopener noreferrer" class="py-2.5 px-3 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 font-bold text-xs text-center flex items-center justify-center gap-1">
            <span>📲</span><span>Kirim WA</span>
          </a>
        </div>
      </div>
    `);
  }

  // ==========================================================================
  // PUBLIC CONTROLLER METHODS (window.AZI)
  // ==========================================================================
  window.AZI = {
    navigate(menuId) {
      if (!currentUser || !currentUser.akses.menus.includes(menuId)) {
        showToast('Akses ditolak untuk membuka menu tersebut!', 'error');
        return;
      }
      activeMenu = menuId;
      renderApp();
    },

    setDateFilter(start, end) {
      filterDateStart = start || '';
      filterDateEnd = end || '';
      renderApp();
    },

    fillDemoLogin(username) {
      const u = document.getElementById('login-username');
      const p = document.getElementById('login-password');
      if (u && p) {
        u.value = username;
        p.value = '123';
      }
    },

    submitLogin(e) {
      e.preventDefault();
      const u = document.getElementById('login-username').value.trim();
      const p = document.getElementById('login-password').value;
      const errBox = document.getElementById('login-error-box');
      const found = db.karyawan.find((k) => k.username.toLowerCase() === u.toLowerCase() && k.password === p);
      if (!found) {
        errBox.textContent = 'Username atau password salah. Data toko tetap terkunci.';
        errBox.classList.remove('hidden');
        return;
      }
      if (!found.aktif) {
        errBox.textContent = 'Akun ini telah dinonaktifkan oleh Pemilik. Silakan hubungi Pemilik Toko.';
        errBox.classList.remove('hidden');
        return;
      }
      saveSession(found);
      activeMenu = found.akses.menus[0] || 'dashboard';
      showToast(`Selamat datang, ${found.nama} (${found.jabatan})!`, 'success');
      renderApp();
    },

    logout() {
      saveSession(null);
      showToast('Anda telah keluar dari sesi Azi Cell.', 'info');
      renderApp();
    },

    submitNewPassword(e, shouldCloseModal = false) {
      e.preventDefault();
      const p1 = document.getElementById('new-pass-1').value;
      const p2 = document.getElementById('new-pass-2').value;
      if (p1 !== p2) {
        showToast('Konfirmasi password tidak cocok!', 'error');
        return;
      }
      const userObj = db.karyawan.find((k) => k.username === currentUser.username);
      if (userObj) {
        userObj.password = p1;
        userObj.wajibGantiPassword = false;
        saveDatabase('CHANGE_PASSWORD', userObj.username, 'Ganti password akun');
        saveSession(userObj);
        if (shouldCloseModal) closeModal();
        showToast('Password baru berhasil disimpan!', 'success');
        renderApp();
      }
    },

    openChangePasswordModal() {
      openModal(`
        <div class="glass-card rounded-2xl p-6 max-w-sm w-full space-y-3">
          <h3 class="text-sm font-extrabold text-white">Ganti Password Akun</h3>
          <form onsubmit="window.AZI.submitNewPassword(event, true)" class="space-y-3 text-xs">
            <input id="new-pass-1" type="password" required minlength="3" placeholder="Password Baru" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
            <input id="new-pass-2" type="password" required minlength="3" placeholder="Ulangi Password Baru" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
            <div class="flex gap-2">
              <button type="submit" class="flex-1 py-2.5 rounded-xl btn-luxury">Simpan</button>
              <button type="button" onclick="window.AZI.closeModal()" class="py-2.5 px-4 rounded-xl bg-slate-800 text-slate-300">Batal</button>
            </div>
          </form>
        </div>
      `);
    },

    handleInstallClick,
    closeModal,
    openReceiptModal,

    forceCheckUpdate() {
      triggerUpdateOverlay('Memeriksa Pembaruan Server...', 'Menarik file terbaru dari repositori GitHub Azi Cell...');
    },

    // ========================================================================
    // POS KASIR ACTIONS (BARANG + JASA / ONGKOS PASANG)
    // ========================================================================
    filterPosCatalog(query) {
      posSearchQuery = String(query || '');
      const grid = document.getElementById('pos-catalog-grid');
      if (grid) grid.innerHTML = renderPosCatalogCards(posSearchQuery);
    },

    setPosField(field, value) {
      if (field === 'customer') posCustomer = value;
      else if (field === 'contact') posContact = value;
      else if (field === 'accountId') posAccountId = value;
      else if (field === 'note') posNote = value;
    },

    addToPosCart(sku) {
      const item = db.barang.find((b) => b.sku === sku && b.aktif);
      if (!item) return;
      const stokTersedia = getStokAkhir(item);
      const existing = posCart.find((c) => c.sku === sku);
      const nextQty = existing ? existing.qty + 1 : 1;
      if (nextQty > stokTersedia) {
        showToast(`Stok ${esc(item.nama)} tidak mencukupi (Tersisa ${stokTersedia} ${esc(item.satuan)})!`, 'error');
        return;
      }
      if (existing) {
        existing.qty = nextQty;
      } else {
        posCart.push({
          sku: item.sku,
          nama: item.nama,
          satuan: item.satuan,
          qty: 1,
          hargaJual: Number(item.hargaJual),
          hargaModal: Number(item.hargaModal)
        });
      }
      posPaidOverride = null;
      renderApp();
    },

    updatePosQty(idx, val) {
      const qty = Number(val);
      if (!posCart[idx] || qty <= 0) return;
      const item = db.barang.find((b) => b.sku === posCart[idx].sku);
      const stok = getStokAkhir(item);
      if (qty > stok) {
        showToast(`Melebihi stok tersedia (${stok})!`, 'error');
        renderApp();
        return;
      }
      posCart[idx].qty = qty;
      posPaidOverride = null;
      renderApp();
    },

    updatePosPrice(idx, val) {
      if (!currentUser.akses.ubah_harga_diskon) {
        showToast('Akun Anda tidak diizinkan mengubah harga jual!', 'error');
        return;
      }
      const price = Number(val);
      if (price < 0 || !posCart[idx]) return;
      posCart[idx].hargaJual = price;
      posPaidOverride = null;
      renderApp();
    },

    addPosService(defaultName, defaultFee) {
      posServices.push({
        nama: defaultName !== undefined ? defaultName : 'Jasa Pasang',
        biaya: Math.max(0, Number(defaultFee) || 0)
      });
      posPaidOverride = null;
      renderApp();
    },

    updatePosServiceName(idx, val) {
      if (!posServices[idx]) return;
      posServices[idx].nama = String(val || '').trim();
    },

    updatePosTotalsLive() {
      const subtotalBarang = posCart.reduce((s, i) => s + i.qty * i.hargaJual, 0);
      const totalJasa = posServices.reduce((s, j) => s + (Number(j.biaya) || 0), 0);
      const subtotal = subtotalBarang + totalJasa;
      const diskonAktual = Math.min(subtotal, Math.max(0, Number(posDiscount) || 0));
      const totalAkhir = Math.max(0, subtotal - diskonAktual);

      const elBrg = document.getElementById('pos-subtotal-barang-display');
      const elJasa = document.getElementById('pos-total-jasa-display');
      const elSub = document.getElementById('pos-subtotal-display');
      const elTot = document.getElementById('pos-total-display');
      const elUang = document.getElementById('pos-uang-diterima');
      if (elBrg) elBrg.textContent = rp(subtotalBarang);
      if (elJasa) elJasa.textContent = rp(totalJasa);
      if (elSub) elSub.textContent = rp(subtotal);
      if (elTot) {
        elTot.textContent = rp(totalAkhir);
        elTot.dataset.total = String(totalAkhir);
      }
      if (elUang && posPaidOverride === null) {
        elUang.value = totalAkhir;
      }
      const infoEl = document.getElementById('pos-change-info');
      const diterima = elUang ? Math.max(0, Number(elUang.value) || 0) : totalAkhir;
      if (infoEl) {
        if (diterima >= totalAkhir) {
          infoEl.innerHTML = `<span class="text-slate-400">Kembalian Tunai:</span><span class="font-mono-num font-bold text-emerald-400">${rp(diterima - totalAkhir)} (Lunas)</span>`;
        } else {
          infoEl.innerHTML = `<span class="text-slate-400">Sisa Piutang Pelanggan:</span><span class="font-mono-num font-bold text-rose-400">${rp(totalAkhir - diterima)} (Belum Lunas)</span>`;
        }
      }
    },

    updatePosServiceFee(idx, val) {
      if (!posServices[idx]) return;
      posServices[idx].biaya = Math.max(0, Number(val) || 0);
      posPaidOverride = null;
      this.updatePosTotalsLive();
    },

    removePosService(idx) {
      posServices.splice(idx, 1);
      posPaidOverride = null;
      renderApp();
    },

    setPosDiscount(val) {
      if (!currentUser.akses.ubah_harga_diskon) return;
      posDiscount = Math.max(0, Number(val) || 0);
      posPaidOverride = null;
      this.updatePosTotalsLive();
    },

    removePosItem(idx) {
      posCart.splice(idx, 1);
      posPaidOverride = null;
      renderApp();
    },

    clearPosCart() {
      posCart = [];
      posServices = [];
      posDiscount = 0;
      posCustomer = '';
      posContact = '';
      posNote = '';
      posPaidOverride = null;
      renderApp();
    },

    setPosQuickPay(nominal) {
      posPaidOverride = Math.max(0, Number(nominal) || 0);
      const uangEl = document.getElementById('pos-uang-diterima');
      if (uangEl) uangEl.value = posPaidOverride;
      this.recalcPosChange();
    },

    recalcPosChange() {
      const totalEl = document.getElementById('pos-total-display');
      const uangEl = document.getElementById('pos-uang-diterima');
      const infoEl = document.getElementById('pos-change-info');
      if (!totalEl || !uangEl || !infoEl) return;
      const total = Number(totalEl.dataset.total) || 0;
      const diterima = Math.max(0, Number(uangEl.value) || 0);
      posPaidOverride = diterima;
      if (diterima >= total) {
        infoEl.innerHTML = `<span class="text-slate-400">Kembalian Tunai:</span><span class="font-mono-num font-bold text-emerald-400">${rp(diterima - total)} (Lunas)</span>`;
      } else {
        infoEl.innerHTML = `<span class="text-slate-400">Sisa Piutang Pelanggan:</span><span class="font-mono-num font-bold text-rose-400">${rp(total - diterima)} (Belum Lunas)</span>`;
      }
    },

    savePosTransaction(statusDokumen) {
      if (isSubmittingLock) return;
      if (posCart.length === 0 && posServices.length === 0) {
        showToast('Keranjang masih kosong! Tambahkan barang atau jasa pasang terlebih dahulu.', 'error');
        return;
      }
      // Validasi setiap baris jasa memiliki nama & nominal >= 0
      const cleanServices = posServices.map((j) => ({
        nama: String(j.nama || '').trim(),
        biaya: Number(j.biaya)
      }));
      for (const j of cleanServices) {
        if (!j.nama || isNaN(j.biaya) || j.biaya < 0) {
          showToast('Lengkapi Nama Jasa & Biaya Jasa yang valid (boleh 0 jika gratis)!', 'error');
          return;
        }
      }

      isSubmittingLock = true;
      try {
        // Validasi ulang stok sebelum finalisasi (Bab 06.C & Bab 14)
        for (const c of posCart) {
          const item = db.barang.find((b) => b.sku === c.sku);
          if (!item || (statusDokumen === 'Final' && getStokAkhir(item) < c.qty)) {
            showToast(`Stok ${esc(c.nama)} tidak mencukupi untuk finalisasi!`, 'error');
            return;
          }
        }

        const subtotalBarang = posCart.reduce((s, i) => s + i.qty * i.hargaJual, 0);
        const totalJasa = cleanServices.reduce((s, j) => s + j.biaya, 0);
        const subtotal = subtotalBarang + totalJasa;
        const diskonAktual = Math.min(subtotal, Math.max(0, Number(posDiscount) || 0));
        const totalAkhir = Math.max(0, subtotal - diskonAktual);
        const totalModalHistoris = posCart.reduce((s, i) => s + i.qty * i.hargaModal, 0);
        const labaKotor = totalAkhir - totalModalHistoris;

        const pelanggan = (document.getElementById('pos-pelanggan').value || '').trim() || 'Pelanggan Umum';
        const kontak = (document.getElementById('pos-kontak').value || '').trim() || '-';
        const catatan = (document.getElementById('pos-catatan').value || '').trim();
        const akunId = document.getElementById('pos-akun').value;
        const akunObj = db.akunKas.find((a) => a.id === akunId) || db.akunKas[0];
        const uangDiterima = Math.max(0, Number(document.getElementById('pos-uang-diterima').value) || 0);

        // Jika belum lunas, pelanggan & kontak wajib diisi (Bab 07.5)
        if (statusDokumen === 'Final' && uangDiterima < totalAkhir && (pelanggan === 'Pelanggan Umum' || kontak === '-')) {
          showToast('Untuk pembelian belum lunas/kredit, Nama & Kontak Pelanggan wajib diisi!', 'error');
          return;
        }

        const kembalian = uangDiterima > totalAkhir ? uangDiterima - totalAkhir : 0;
        // Bab 07: Uang masuk yang dicatat tetap maksimal sebesar Total Akhir
        const jumlahTerbayar = Math.min(totalAkhir, uangDiterima);
        const sisaPiutang = Math.max(0, totalAkhir - jumlahTerbayar);
        const statusBayar = sisaPiutang === 0 ? 'Lunas' : (jumlahTerbayar > 0 ? 'DP/Sebagian' : 'Belum Bayar');

        const noTrx = nextSeqNo('PJ', db.penjualan, 'no', 3);
        const waktu = nowStr();

        if (statusDokumen === 'Final') {
          posCart.forEach((c) => {
            const item = db.barang.find((b) => b.sku === c.sku);
            const sebelum = getStokAkhir(item);
            item.keluar = (Number(item.keluar) || 0) + c.qty;
            db.riwayatStok.unshift({
              id: genId('MUT'),
              waktu,
              sku: item.sku,
              nama: item.nama,
              jenis: 'Penjualan',
              ref: noTrx,
              masuk: 0,
              keluar: c.qty,
              sebelum,
              sesudah: getStokAkhir(item),
              modalSatuan: c.hargaModal,
              alasan: cleanServices.length > 0 ? 'Penjualan + Jasa Pasang' : 'Penjualan Final',
              petugas: currentUser.username
            });
          });

          if (jumlahTerbayar > 0) {
            db.kasModal.unshift({
              id: genId('KAS'),
              tanggalJam: waktu,
              jenis: 'Masuk',
              kategori: cleanServices.length > 0 && posCart.length === 0 ? 'Jasa Pasang Kasir' : 'Penjualan Barang',
              akunAsal: '',
              akunTujuan: akunObj.id,
              nominal: jumlahTerbayar,
              noRef: noTrx,
              keterangan: `Penjualan ${noTrx}${cleanServices.length > 0 ? ' (+Jasa Pasang)' : ''} (${pelanggan})`,
              petugas: currentUser.username
            });
          }
        }

        db.penjualan.unshift({
          no: noTrx,
          tanggalJam: waktu,
          statusDokumen,
          pelanggan,
          kontak,
          items: JSON.parse(JSON.stringify(posCart)),
          jasaItems: JSON.parse(JSON.stringify(cleanServices)),
          totalJasa,
          subtotal,
          diskon: diskonAktual,
          totalAkhir,
          totalModalHistoris,
          labaKotor,
          metodeBayar: akunObj.tipe,
          akunId: akunObj.id,
          uangDiterima,
          kembalian,
          jumlahTerbayar,
          sisaPiutang,
          statusBayar,
          jatuhTempo: '',
          petugas: currentUser.username,
          catatan
        });

        posCart = [];
        posServices = [];
        posDiscount = 0;
        posCustomer = '';
        posContact = '';
        posNote = '';
        posPaidOverride = null;
        saveDatabase('CREATE_SALE_' + statusDokumen.toUpperCase(), noTrx, `Total ${rp(totalAkhir)}${totalJasa > 0 ? ' (Jasa ' + rp(totalJasa) + ')' : ''}`);
        renderApp();

        if (statusDokumen === 'Final') {
          showToast(`Transaksi ${noTrx} berhasil disimpan!`, 'success');
          openReceiptModal('PENJUALAN', noTrx);
        } else {
          showToast(`Draf ${noTrx} disimpan (Belum mengubah stok/kas).`, 'info');
        }
      } finally {
        isSubmittingLock = false;
      }
    },

    finalizeDraftSale(noTrx) {
      const p = db.penjualan.find((x) => x.no === noTrx && x.statusDokumen === 'Draf');
      if (!p) return;
      if (p.uangDiterima < p.totalAkhir && (p.pelanggan === 'Pelanggan Umum' || !p.kontak || p.kontak === '-')) {
        showToast('Draf belum lunas memerlukan Nama & Kontak Pelanggan sebelum difinalisasi!', 'error');
        return;
      }
      for (const c of (p.items || [])) {
        const item = db.barang.find((b) => b.sku === c.sku);
        if (!item || getStokAkhir(item) < c.qty) {
          showToast(`Stok ${esc(c.nama)} tidak cukup untuk memfinalisasi draf!`, 'error');
          return;
        }
      }
      const waktu = nowStr();
      p.statusDokumen = 'Final';
      p.tanggalJam = waktu;
      (p.items || []).forEach((c) => {
        const item = db.barang.find((b) => b.sku === c.sku);
        const sebelum = getStokAkhir(item);
        item.keluar = (Number(item.keluar) || 0) + c.qty;
        db.riwayatStok.unshift({
          id: genId('MUT'),
          waktu,
          sku: item.sku,
          nama: item.nama,
          jenis: 'Penjualan',
          ref: p.no,
          masuk: 0,
          keluar: c.qty,
          sebelum,
          sesudah: getStokAkhir(item),
          modalSatuan: c.hargaModal,
          alasan: 'Finalisasi Draf Penjualan',
          petugas: currentUser.username
        });
      });
      if (p.jumlahTerbayar > 0) {
        db.kasModal.unshift({
          id: genId('KAS'),
          tanggalJam: waktu,
          jenis: 'Masuk',
          kategori: 'Penjualan Barang',
          akunAsal: '',
          akunTujuan: p.akunId,
          nominal: p.jumlahTerbayar,
          noRef: p.no,
          keterangan: `Finalisasi Draf ${p.no} (${p.pelanggan})`,
          petugas: currentUser.username
        });
      }
      saveDatabase('FINALIZE_DRAFT', p.no, 'Draf difinalisasi');
      showToast(`Draf ${p.no} berhasil difinalisasi!`, 'success');
      renderApp();
      openReceiptModal('PENJUALAN', p.no);
    },

    deleteDraftSale(noTrx) {
      const idx = db.penjualan.findIndex((x) => x.no === noTrx && x.statusDokumen === 'Draf');
      if (idx === -1) return;
      db.penjualan.splice(idx, 1);
      saveDatabase('DELETE_DRAFT_SALE', noTrx, 'Draf penjualan dihapus');
      showToast(`Draf ${noTrx} dihapus.`, 'info');
      renderApp();
    },

    // ========================================================================
    // SERVIS ACTIONS (BAB 08 — MULTI SPAREPART, MULTI JASA, ATOMIC STOCK CUT)
    // ========================================================================
    submitNewService(e) {
      e.preventDefault();
      const pelanggan = document.getElementById('srv-pelanggan').value.trim();
      const kontak = document.getElementById('srv-kontak').value.trim();
      const perangkat = document.getElementById('srv-perangkat').value.trim();
      const merekModel = document.getElementById('srv-merek').value.trim();
      const jenisServis = document.getElementById('srv-jenis').value.trim();
      const keluhan = document.getElementById('srv-keluhan').value.trim();
      const kelengkapan = document.getElementById('srv-kelengkapan').value.trim();
      const estimasiBiaya = Math.max(0, Number(document.getElementById('srv-estimasi').value) || 0);
      const dpAwal = Math.max(0, Number(document.getElementById('srv-dp').value) || 0);
      const akunId = document.getElementById('srv-akun').value;
      const teknisi = (document.getElementById('srv-teknisi') && document.getElementById('srv-teknisi').value) || currentUser.username;
      const akunObj = db.akunKas.find((a) => a.id === akunId) || db.akunKas[0];

      const noSrv = nextSeqNo('SRV', db.servis, 'no', 3);
      const waktu = nowStr();
      const sisaAwal = Math.max(0, estimasiBiaya - dpAwal);

      // Bab 08: DP sebelum servis selesai adalah uang masuk & uang muka pelanggan, bukan omzet saat diterima
      if (dpAwal > 0) {
        db.kasModal.unshift({
          id: genId('KAS'),
          tanggalJam: waktu,
          jenis: 'Masuk',
          kategori: 'DP / Pembayaran Servis',
          akunAsal: '',
          akunTujuan: akunId,
          nominal: dpAwal,
          noRef: noSrv,
          keterangan: `DP Awal Servis ${noSrv} (${pelanggan})`,
          petugas: currentUser.username
        });
        db.pembayaranTagihan.unshift({
          id: genId('PAY'),
          tanggalJam: waktu,
          jenis: 'DP Servis',
          noRef: noSrv,
          pihak: pelanggan,
          totalAwal: estimasiBiaya,
          sudahDibayar: 0,
          nominal: dpAwal,
          sisaAkhir: sisaAwal,
          metode: akunObj.tipe,
          akunId,
          refTransfer: '',
          statusKonfirmasi: 'Terkonfirmasi',
          petugas: currentUser.username,
          catatan: `DP awal saat terima servis ${merekModel}`
        });
      }

      db.servis.unshift({
        no: noSrv,
        tanggalTerima: waktu,
        tanggalSelesai: '',
        tanggalDiambil: '',
        pelanggan,
        kontak,
        perangkat,
        merekModel,
        keluhan,
        jenisServis,
        kelengkapan,
        statusPengerjaan: 'Diterima',
        tindakan: '',
        spareparts: [],
        totalSparepart: 0,
        totalModalPart: 0,
        namaJasa: jenisServis,
        biayaJasa: 0,
        jasaItems: [{ nama: jenisServis, biaya: 0 }],
        diskon: 0,
        estimasiBiaya,
        totalBiayaFinal: 0,
        dpAwal,
        totalTerbayar: dpAwal,
        sisaTagihan: sisaAwal,
        statusBayar: dpAwal > 0 ? 'DP/Sebagian' : 'Belum Bayar',
        stokPartTerpotong: false,
        alasanBatal: '',
        teknisi,
        petugasTerima: currentUser.username
      });

      saveDatabase('CREATE_SERVICE', noSrv, `Terima servis ${merekModel} (${pelanggan})`);
      showToast(`Servis ${noSrv} berhasil dicatat dengan status Diterima!`, 'success');
      renderApp();
      openReceiptModal('SERVIS_TERIMA', noSrv);
    },

    openServiceWorkModal(noSrv) {
      const s = db.servis.find((x) => x.no === noSrv);
      if (!s) return;
      const existingJasa = (Array.isArray(s.jasaItems) && s.jasaItems.length > 0)
        ? JSON.parse(JSON.stringify(s.jasaItems))
        : [{ nama: s.namaJasa || s.jenisServis || 'Jasa Servis', biaya: Number(s.biayaJasa) || 0 }];
      editingServiceDraft = {
        no: s.no,
        statusPengerjaan: s.statusPengerjaan,
        teknisi: s.teknisi || currentUser.username,
        tindakan: s.tindakan || '',
        spareparts: JSON.parse(JSON.stringify(s.spareparts || [])),
        jasaItems: existingJasa,
        diskon: Number(s.diskon) || 0,
        alasanBatal: s.alasanBatal || '',
        totalTerbayar: Number(s.totalTerbayar) || 0
      };
      this.renderServiceWorkModalContent();
    },

    renderServiceWorkModalContent() {
      const d = editingServiceDraft;
      if (!d) return;
      const totalPart = d.spareparts.reduce((sum, sp) => sum + (Number(sp.qty) || 0) * (Number(sp.hargaJual) || 0), 0);
      const totalJasa = d.jasaItems.reduce((sum, j) => sum + (Number(j.biaya) || 0), 0);
      const totalFinal = Math.max(0, totalPart + totalJasa - (Number(d.diskon) || 0));
      const sisaTagihan = d.statusPengerjaan === 'Batal' ? 0 : Math.max(0, totalFinal - d.totalTerbayar);

      openModal(`
        <div class="glass-card rounded-2xl p-5 sm:p-6 max-w-xl w-full space-y-4 text-xs my-6">
          <div class="flex items-center justify-between border-b border-slate-800 pb-2">
            <h3 class="text-sm font-extrabold text-white">Pengerjaan, Sparepart & Jasa Servis ${esc(d.no)}</h3>
            <button onclick="window.AZI.closeModal()" class="text-slate-400 hover:text-white text-xl">&times;</button>
          </div>

          <form onsubmit="window.AZI.saveServiceProgress(event, '${esc(d.no)}')" class="space-y-3.5">
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-[10px] text-slate-400 mb-1">Status Pengerjaan</label>
                <select id="upd-srv-status" onchange="window.AZI.updateDraftServiceField('statusPengerjaan', this.value)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-bold">
                  ${['Diterima', 'Dikerjakan', 'Selesai', 'Diambil', 'Batal'].map((st) => `<option value="${st}" ${d.statusPengerjaan === st ? 'selected' : ''}>${st}</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="block text-[10px] text-slate-400 mb-1">Teknisi</label>
                <select id="upd-srv-teknisi" onchange="window.AZI.updateDraftServiceField('teknisi', this.value)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                  ${db.karyawan.filter((k) => k.aktif).map((k) => `<option value="${esc(k.username)}" ${d.teknisi === k.username ? 'selected' : ''}>${esc(k.nama)}</option>`).join('')}
                </select>
              </div>
            </div>

            <input id="upd-srv-tindakan" type="text" value="${esc(d.tindakan)}" oninput="window.AZI.updateDraftServiceField('tindakan', this.value, false)" placeholder="Tindakan Teknisi (mis: Ganti LCD Ori + Bersihkan Soket)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />

            <!-- DAFTAR SPARE PART -->
            <div class="p-3 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2.5">
              <div class="font-bold text-amber-400">1. Spare Part dari Stok (Otomatis potong stok saat Selesai)</div>
              <div class="flex gap-1.5">
                <select id="upd-srv-part-sku" class="flex-1 min-w-0 px-2.5 py-2 rounded-lg bg-slate-950 border border-slate-700 text-white text-[11px]">
                  <option value="">-- Pilih Spare Part --</option>
                  ${db.barang.filter((b) => b.aktif).map((b) => `<option value="${esc(b.sku)}">${esc(b.sku)} — ${esc(b.nama)} (${rp(b.hargaJual)} | Stok: ${getStokAkhir(b)})</option>`).join('')}
                </select>
                <input id="upd-srv-part-qty" type="number" min="1" value="1" class="w-16 px-2 py-2 rounded-lg bg-slate-950 border border-slate-700 text-center font-mono-num text-white text-[11px]" />
                <button type="button" onclick="window.AZI.addDraftServicePart()" class="px-3 py-2 rounded-lg btn-cyber text-[11px] shrink-0">+ Part</button>
              </div>
              <div class="space-y-1.5">
                ${d.spareparts.length === 0 ? `<div class="text-[11px] text-slate-500">Belum ada spare part ditambahkan.</div>` : d.spareparts.map((sp, idx) => `
                  <div class="flex items-center justify-between gap-2 bg-slate-950 px-2.5 py-1.5 rounded-lg border border-slate-800">
                    <div class="min-w-0">
                      <span class="font-bold text-white">${esc(sp.nama)}</span>
                      <span class="text-slate-400 ml-1">(${sp.qty}x ${rp(sp.hargaJual)})</span>
                      ${sp.terpotong ? `<span class="ml-1 px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[9px] font-bold">Stok Terpotong</span>` : ''}
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <span class="font-mono-num font-bold text-amber-300">${rp(sp.qty * sp.hargaJual)}</span>
                      ${!sp.terpotong ? `<button type="button" onclick="window.AZI.removeDraftServicePart(${idx})" class="text-rose-400 font-bold">&times;</button>` : ''}
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>

            <!-- DAFTAR JASA SERVIS -->
            <div class="p-3 rounded-xl bg-sky-950/30 border border-sky-500/30 space-y-2.5">
              <div class="flex items-center justify-between">
                <div class="font-bold text-sky-300">2. Rincian Biaya Jasa Servis (Isi 0 jika gratis) *</div>
                <button type="button" onclick="window.AZI.addDraftServiceJasa()" class="px-2 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/40 text-sky-200 text-[10px] font-bold">+ Tambah Baris Jasa</button>
              </div>
              <div class="space-y-1.5">
                ${d.jasaItems.map((j, idx) => `
                  <div class="flex items-center gap-1.5">
                    <input type="text" required value="${esc(j.nama)}" placeholder="Nama Tindakan Jasa (mis: Jasa Pasang LCD)" oninput="window.AZI.updateDraftServiceJasa(${idx}, 'nama', this.value)" class="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-white text-[11px]" />
                    <input type="number" min="0" required value="${Number(j.biaya) || 0}" oninput="window.AZI.updateDraftServiceJasa(${idx}, 'biaya', this.value)" class="w-28 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-amber-500/40 text-right font-mono-num text-amber-300 text-[11px] font-bold" />
                    ${d.jasaItems.length > 1 ? `<button type="button" onclick="window.AZI.removeDraftServiceJasa(${idx})" class="px-2 py-1.5 rounded-lg bg-rose-950 text-rose-300 font-bold">&times;</button>` : ''}
                  </div>
                `).join('')}
              </div>
            </div>

            <!-- DISKON & RINGKASAN BIAYA -->
            <div class="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-1.5">
              <div class="flex items-center justify-between">
                <span class="text-slate-300">Diskon Servis (Rp):</span>
                <input type="number" min="0" value="${d.diskon}" ${currentUser.akses.ubah_harga_diskon ? '' : 'readonly'} oninput="window.AZI.updateDraftServiceDiskon(this.value)" class="w-28 px-2 py-1 rounded bg-slate-950 border border-slate-700 text-right font-mono-num text-white" />
              </div>
              <div class="flex justify-between text-slate-300"><span>Total Spare Part:</span><b id="srv-sum-part" class="font-mono-num">${rp(totalPart)}</b></div>
              <div class="flex justify-between text-sky-300"><span>Total Biaya Jasa:</span><b id="srv-sum-jasa" class="font-mono-num">${rp(totalJasa)}</b></div>
              <div class="flex justify-between text-sm font-extrabold text-amber-400 pt-1 border-t border-slate-800"><span>Total Biaya Final:</span><span id="srv-sum-final" class="font-mono-num">${rp(totalFinal)}</span></div>
              <div class="flex justify-between text-[11px] text-emerald-300"><span>Sudah Dibayar / DP:</span><span class="font-mono-num">${rp(d.totalTerbayar)}</span></div>
              <div class="flex justify-between text-[11px] font-bold text-rose-300"><span>Sisa Tagihan:</span><span id="srv-sum-sisa" class="font-mono-num">${rp(sisaTagihan)}</span></div>
            </div>

            ${d.statusPengerjaan === 'Batal' ? `
              <input id="upd-srv-batal" type="text" required value="${esc(d.alasanBatal)}" oninput="window.AZI.updateDraftServiceField('alasanBatal', this.value, false)" placeholder="Alasan Pembatalan Servis (WAJIB DIISI) *" class="w-full px-3 py-2 rounded-xl bg-rose-950/40 border border-rose-500/50 text-white" />
            ` : `
              <input id="upd-srv-batal" type="hidden" value="${esc(d.alasanBatal)}" />
            `}

            <div class="flex gap-2 pt-1">
              <button type="submit" class="flex-1 py-2.5 rounded-xl btn-luxury">Simpan Perubahan Servis</button>
              <button type="button" onclick="window.AZI.closeModal()" class="py-2.5 px-4 rounded-xl bg-slate-800 text-slate-300">Tutup</button>
            </div>
          </form>
        </div>
      `);
    },

    updateDraftServiceField(field, value, rerender = true) {
      if (!editingServiceDraft) return;
      editingServiceDraft[field] = value;
      if (rerender) this.renderServiceWorkModalContent();
    },

    addDraftServicePart() {
      if (!editingServiceDraft) return;
      const skuEl = document.getElementById('upd-srv-part-sku');
      const qtyEl = document.getElementById('upd-srv-part-qty');
      const sku = skuEl ? skuEl.value : '';
      const qty = Math.max(1, Number(qtyEl ? qtyEl.value : 1) || 1);
      if (!sku) {
        showToast('Pilih spare part terlebih dahulu.', 'warn');
        return;
      }
      const item = db.barang.find((b) => b.sku === sku);
      if (!item) return;
      const alreadyPendingQty = editingServiceDraft.spareparts
        .filter((sp) => sp.sku === sku && !sp.terpotong)
        .reduce((sum, sp) => sum + (Number(sp.qty) || 0), 0);
      if (alreadyPendingQty + qty > getStokAkhir(item)) {
        showToast(`Stok ${esc(item.nama)} tidak mencukupi (Tersisa ${getStokAkhir(item)})!`, 'error');
        return;
      }
      editingServiceDraft.spareparts.push({
        sku: item.sku,
        nama: item.nama,
        qty,
        hargaJual: Number(item.hargaJual),
        hargaModal: Number(item.hargaModal),
        terpotong: false
      });
      this.renderServiceWorkModalContent();
    },

    removeDraftServicePart(idx) {
      if (!editingServiceDraft || !editingServiceDraft.spareparts[idx]) return;
      if (editingServiceDraft.spareparts[idx].terpotong) {
        showToast('Spare part ini stoknya sudah terpotong.', 'warn');
        return;
      }
      editingServiceDraft.spareparts.splice(idx, 1);
      this.renderServiceWorkModalContent();
    },

    addDraftServiceJasa() {
      if (!editingServiceDraft) return;
      editingServiceDraft.jasaItems.push({ nama: '', biaya: 0 });
      this.renderServiceWorkModalContent();
    },

    updateServiceDraftSummaryLive() {
      const d = editingServiceDraft;
      if (!d) return;
      const totalPart = d.spareparts.reduce((sum, sp) => sum + (Number(sp.qty) || 0) * (Number(sp.hargaJual) || 0), 0);
      const totalJasa = d.jasaItems.reduce((sum, j) => sum + (Number(j.biaya) || 0), 0);
      const diskonAktual = Math.min(totalPart + totalJasa, Math.max(0, Number(d.diskon) || 0));
      const totalFinal = Math.max(0, totalPart + totalJasa - diskonAktual);
      const sisaTagihan = d.statusPengerjaan === 'Batal' ? 0 : Math.max(0, totalFinal - d.totalTerbayar);
      const setTxt = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
      setTxt('srv-sum-part', rp(totalPart));
      setTxt('srv-sum-jasa', rp(totalJasa));
      setTxt('srv-sum-final', rp(totalFinal));
      setTxt('srv-sum-sisa', rp(sisaTagihan));
    },

    updateDraftServiceDiskon(val) {
      if (!editingServiceDraft) return;
      editingServiceDraft.diskon = Math.max(0, Number(val) || 0);
      this.updateServiceDraftSummaryLive();
    },

    updateDraftServiceJasa(idx, field, val) {
      if (!editingServiceDraft || !editingServiceDraft.jasaItems[idx]) return;
      if (field === 'nama') {
        editingServiceDraft.jasaItems[idx].nama = String(val || '').trim();
      } else {
        editingServiceDraft.jasaItems[idx].biaya = Math.max(0, Number(val) || 0);
        this.updateServiceDraftSummaryLive();
      }
    },

    removeDraftServiceJasa(idx) {
      if (!editingServiceDraft || editingServiceDraft.jasaItems.length <= 1) return;
      editingServiceDraft.jasaItems.splice(idx, 1);
      this.renderServiceWorkModalContent();
    },

    saveServiceProgress(e, noSrv) {
      e.preventDefault();
      const s = db.servis.find((x) => x.no === noSrv);
      const d = editingServiceDraft;
      if (!s || !d) return;

      const newStatus = d.statusPengerjaan;
      const tindakan = String(d.tindakan || '').trim();
      const alasanBatal = String(d.alasanBatal || '').trim();
      const cleanJasa = (d.jasaItems || []).map((j) => ({
        nama: String(j.nama || '').trim(),
        biaya: Math.max(0, Number(j.biaya) || 0)
      })).filter((j) => j.nama !== '');

      if (newStatus === 'Batal' && !alasanBatal) {
        showToast('Status Batal memerlukan alasan pembatalan!', 'error');
        return;
      }
      if ((newStatus === 'Selesai' || newStatus === 'Diambil') && cleanJasa.length === 0) {
        showToast('Minimal satu Nama Tindakan Jasa wajib diisi sebelum status Selesai!', 'error');
        return;
      }

      const waktu = nowStr();

      // 1. Jika status Selesai / Diambil: validasi SEMUA sparepart yg belum terpotong secara atomik dulu!
      if (newStatus === 'Selesai' || newStatus === 'Diambil') {
        const neededBySku = {};
        d.spareparts.forEach((sp) => {
          if (!sp.terpotong) {
            neededBySku[sp.sku] = (neededBySku[sp.sku] || 0) + (Number(sp.qty) || 0);
          }
        });
        for (const sku of Object.keys(neededBySku)) {
          const item = db.barang.find((b) => b.sku === sku);
          if (!item || getStokAkhir(item) < neededBySku[sku]) {
            showToast(`Stok spare part ${esc(item ? item.nama : sku)} tidak cukup (Butuh ${neededBySku[sku]})!`, 'error');
            return;
          }
        }
        // Semua valid -> potong stok untuk spare part yang belum terpotong
        d.spareparts.forEach((sp) => {
          if (!sp.terpotong) {
            const item = db.barang.find((b) => b.sku === sp.sku);
            const sebelum = getStokAkhir(item);
            item.keluar = (Number(item.keluar) || 0) + sp.qty;
            sp.terpotong = true;
            db.riwayatStok.unshift({
              id: genId('MUT'),
              waktu,
              sku: item.sku,
              nama: item.nama,
              jenis: 'Pemakaian Servis',
              ref: s.no,
              masuk: 0,
              keluar: sp.qty,
              sebelum,
              sesudah: getStokAkhir(item),
              modalSatuan: sp.hargaModal,
              alasan: `Servis Selesai ${s.no}`,
              petugas: currentUser.username
            });
          }
        });
        if (!s.tanggalSelesai) s.tanggalSelesai = waktu;
      }

      // 2. Jika dibatalkan setelah part sempat terpotong -> kembalikan stok part otomatis!
      if (newStatus === 'Batal') {
        d.spareparts.forEach((sp) => {
          if (sp.terpotong) {
            const item = db.barang.find((b) => b.sku === sp.sku);
            if (item) {
              const sebelum = getStokAkhir(item);
              item.masuk = (Number(item.masuk) || 0) + sp.qty;
              db.riwayatStok.unshift({
                id: genId('MUT'),
                waktu,
                sku: item.sku,
                nama: item.nama,
                jenis: 'Pengembalian Batal Servis',
                ref: s.no,
                masuk: sp.qty,
                keluar: 0,
                sebelum,
                sesudah: getStokAkhir(item),
                modalSatuan: sp.hargaModal,
                alasan: `Batal Servis ${s.no}: ${alasanBatal}`,
                petugas: currentUser.username
              });
            }
            sp.terpotong = false;
          }
        });
      }

      s.teknisi = d.teknisi;
      s.tindakan = tindakan;
      s.spareparts = d.spareparts;
      s.jasaItems = cleanJasa;
      s.namaJasa = cleanJasa.map((j) => j.nama).join(', ');
      s.biayaJasa = cleanJasa.reduce((sum, j) => sum + j.biaya, 0);
      s.totalSparepart = s.spareparts.reduce((sum, sp) => sum + sp.qty * sp.hargaJual, 0);
      s.totalModalPart = s.spareparts.reduce((sum, sp) => sum + sp.qty * sp.hargaModal, 0);
      s.diskon = Math.min(s.totalSparepart + s.biayaJasa, Math.max(0, Number(d.diskon) || 0));
      s.totalBiayaFinal = Math.max(0, s.totalSparepart + s.biayaJasa - s.diskon);
      s.stokPartTerpotong = s.spareparts.some((sp) => sp.terpotong);

      if (newStatus === 'Diambil' && !s.tanggalDiambil) s.tanggalDiambil = waktu;
      s.statusPengerjaan = newStatus;
      s.alasanBatal = alasanBatal;

      if (newStatus === 'Batal') {
        s.sisaTagihan = 0;
        s.statusBayar = s.totalTerbayar > 0 ? 'Batal (Cek DP)' : 'Batal';
      } else {
        const basisTagihan = (newStatus === 'Selesai' || newStatus === 'Diambil') ? s.totalBiayaFinal : (s.totalBiayaFinal || s.estimasiBiaya);
        s.sisaTagihan = Math.max(0, basisTagihan - s.totalTerbayar);
        s.statusBayar = (s.sisaTagihan === 0 && basisTagihan > 0) ? 'Lunas' : (s.totalTerbayar > 0 ? 'DP/Sebagian' : 'Belum Bayar');
      }

      editingServiceDraft = null;
      saveDatabase('UPDATE_SERVICE', s.no, `Status -> ${newStatus}, Total ${rp(s.totalBiayaFinal)}`);
      closeModal();
      showToast(`Servis ${s.no} diperbarui ke status ${newStatus}!`, 'success');
      renderApp();
    },

    // ========================================================================
    // STOK & PEMBELIAN ACTIONS (BAB 06)
    // ========================================================================
    filterStokTable(query) {
      stokSearchQuery = String(query || '');
      const tbody = document.getElementById('stok-table-body');
      if (tbody) tbody.innerHTML = renderStokTableRows(stokSearchQuery);
    },

    editMasterBarang(sku) {
      const b = db.barang.find((x) => x.sku === sku);
      if (!b) return;
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      setVal('brg-sku', b.sku);
      setVal('brg-barcode', b.barcode === '-' ? '' : (b.barcode || ''));
      setVal('brg-nama', b.nama);
      setVal('brg-kategori', b.kategori);
      setVal('brg-satuan', b.satuan);
      setVal('brg-modal', b.hargaModal);
      setVal('brg-jual', b.hargaJual);
      setVal('brg-awal', b.stokAwal);
      setVal('brg-min', b.stokMinimum);
      setVal('brg-pemasok', b.pemasok === '-' ? '' : (b.pemasok || ''));
      setVal('brg-catatan', b.catatan || '');
      showToast(`Mode edit barang ${esc(b.sku)}. Ubah data lalu klik Simpan Data Barang.`, 'info');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    toggleBarangActive(sku) {
      const b = db.barang.find((x) => x.sku === sku);
      if (!b) return;
      b.aktif = !b.aktif;
      saveDatabase('TOGGLE_ITEM_ACTIVE', sku, `Aktif: ${b.aktif}`);
      showToast(`Barang ${esc(sku)} sekarang ${b.aktif ? 'Aktif' : 'Nonaktif'}.`, 'info');
      renderApp();
    },

    submitMasterBarang(e) {
      e.preventDefault();
      const sku = document.getElementById('brg-sku').value.trim().toUpperCase();
      const barcode = (document.getElementById('brg-barcode').value || '').trim() || '-';
      const nama = document.getElementById('brg-nama').value.trim();
      const kategori = document.getElementById('brg-kategori').value.trim();
      const satuan = document.getElementById('brg-satuan').value.trim();
      const hargaModal = Math.max(0, Number(document.getElementById('brg-modal').value) || 0);
      const hargaJual = Math.max(0, Number(document.getElementById('brg-jual').value) || 0);
      const stokAwal = Math.max(0, Number(document.getElementById('brg-awal').value) || 0);
      const stokMinimum = Math.max(0, Number(document.getElementById('brg-min').value) || 0);
      const pemasok = ((document.getElementById('brg-pemasok') && document.getElementById('brg-pemasok').value) || '').trim() || '-';
      const catatan = ((document.getElementById('brg-catatan') && document.getElementById('brg-catatan').value) || '').trim();

      const existing = db.barang.find((b) => b.sku === sku);
      if (existing) {
        existing.barcode = barcode;
        existing.nama = nama;
        existing.kategori = kategori;
        existing.satuan = satuan;
        existing.hargaModal = hargaModal;
        existing.hargaJual = hargaJual;
        existing.stokMinimum = stokMinimum;
        existing.pemasok = pemasok;
        existing.catatan = catatan;
        showToast(`Data barang ${esc(sku)} berhasil diperbarui!`, 'success');
      } else {
        db.barang.push({
          sku, barcode, nama, kategori, satuan, hargaModal, hargaJual,
          stokAwal, masuk: 0, keluar: 0, stokMinimum, pemasok, aktif: true, catatan: catatan || 'Saldo stok awal'
        });
        if (stokAwal > 0) {
          db.riwayatStok.unshift({
            id: genId('MUT'),
            waktu: nowStr(),
            sku,
            nama,
            jenis: 'Stok Awal',
            ref: 'INIT',
            masuk: stokAwal,
            keluar: 0,
            sebelum: 0,
            sesudah: stokAwal,
            modalSatuan: hargaModal,
            alasan: 'Input master barang baru',
            petugas: currentUser.username
          });
        }
        showToast(`Barang baru ${esc(sku)} ditambahkan!`, 'success');
      }
      saveDatabase('SAVE_ITEM', sku, nama);
      renderApp();
    },

    submitStockAdjustment(e) {
      e.preventDefault();
      const sku = document.getElementById('adj-sku').value;
      const jenis = document.getElementById('adj-jenis').value;
      const qty = Number(document.getElementById('adj-qty').value) || 0;
      const alasan = document.getElementById('adj-alasan').value.trim();
      const item = db.barang.find((b) => b.sku === sku);
      if (!item || qty <= 0) return;

      const sebelum = getStokAkhir(item);
      if (jenis === 'KELUAR' && sebelum < qty) {
        showToast('Penyesuaian ditolak: Tidak boleh membuat stok menjadi negatif!', 'error');
        return;
      }
      if (jenis === 'KELUAR') item.keluar = (Number(item.keluar) || 0) + qty;
      else item.masuk = (Number(item.masuk) || 0) + qty;

      db.riwayatStok.unshift({
        id: genId('MUT'),
        waktu: nowStr(),
        sku: item.sku,
        nama: item.nama,
        jenis: 'Penyesuaian (' + alasan + ')',
        ref: 'ADJ',
        masuk: jenis === 'MASUK' ? qty : 0,
        keluar: jenis === 'KELUAR' ? qty : 0,
        sebelum,
        sesudah: getStokAkhir(item),
        modalSatuan: item.hargaModal,
        alasan,
        petugas: currentUser.username
      });
      saveDatabase('ADJUST_STOCK', sku, `${jenis} ${qty} (${alasan})`);
      showToast('Penyesuaian stok berhasil dicatat!', 'success');
      renderApp();
    },

    onPembelianItemChange(sku) {
      const item = db.barang.find((b) => b.sku === sku);
      const hargaEl = document.getElementById('pb-harga');
      if (item && hargaEl) {
        hargaEl.value = Number(item.hargaModal) || 0;
        this.recalcPembelianTotal(true);
      }
    },

    recalcPembelianTotal(syncPaid) {
      const qty = Math.max(0, Number((document.getElementById('pb-qty') || {}).value) || 0);
      const harga = Math.max(0, Number((document.getElementById('pb-harga') || {}).value) || 0);
      const total = qty * harga;
      const totalEl = document.getElementById('pb-total-preview');
      const dibayarEl = document.getElementById('pb-dibayar');
      const utangEl = document.getElementById('pb-utang-preview');
      if (totalEl) totalEl.textContent = rp(total);
      if (syncPaid && dibayarEl) dibayarEl.value = total;
      const dibayar = Math.max(0, Number((dibayarEl || {}).value) || 0);
      const sisa = Math.max(0, total - Math.min(total, dibayar));
      if (utangEl) {
        utangEl.className = sisa === 0 ? 'text-[11px] text-emerald-300 font-mono-num' : 'text-[11px] text-amber-300 font-mono-num';
        utangEl.textContent = sisa === 0
          ? 'Status: Lunas (Sisa Utang: Rp0)'
          : `Status: ${dibayar > 0 ? 'Sebagian' : 'Belum Bayar'} (Sisa Utang: ${rp(sisa)})`;
      }
    },

    fillPembelianFullPay() {
      this.recalcPembelianTotal(true);
    },

    submitPembelian(e) {
      e.preventDefault();
      const pemasok = document.getElementById('pb-pemasok').value.trim();
      const refNota = document.getElementById('pb-ref').value.trim();
      const sku = document.getElementById('pb-sku').value;
      const qty = Number(document.getElementById('pb-qty').value) || 0;
      const hargaBeli = Math.max(0, Number(document.getElementById('pb-harga').value) || 0);
      const dibayar = Math.max(0, Number(document.getElementById('pb-dibayar').value) || 0);
      const akunId = document.getElementById('pb-akun').value;

      const item = db.barang.find((b) => b.sku === sku);
      if (!item || qty <= 0) return;

      const total = qty * hargaBeli;
      const bayarAktual = Math.min(total, dibayar);
      const sisaUtang = Math.max(0, total - bayarAktual);
      const statusBayar = sisaUtang === 0 ? 'Lunas' : (bayarAktual > 0 ? 'Sebagian' : 'Belum Bayar');

      // Hitung Rata-Rata Tertimbang Harga Modal (Bab 06.C)
      const stokLama = Math.max(0, getStokAkhir(item));
      const nilaiLama = stokLama * (Number(item.hargaModal) || 0);
      const nilaiBaru = qty * hargaBeli;
      item.hargaModal = Math.round((nilaiLama + nilaiBaru) / (stokLama + qty));
      item.masuk = (Number(item.masuk) || 0) + qty;
      item.pemasok = pemasok;

      const noPb = nextSeqNo('PB', db.pembelian, 'no', 3);
      const waktu = nowStr();

      db.riwayatStok.unshift({
        id: genId('MUT'),
        waktu,
        sku: item.sku,
        nama: item.nama,
        jenis: 'Pembelian Masuk',
        ref: noPb,
        masuk: qty,
        keluar: 0,
        sebelum: stokLama,
        sesudah: getStokAkhir(item),
        modalSatuan: hargaBeli,
        alasan: `Pembelian dari ${pemasok} (${refNota})`,
        petugas: currentUser.username
      });

      db.pembelian.unshift({
        no: noPb,
        tanggal: todayStr(),
        pemasok,
        refNota,
        items: [{ sku: item.sku, nama: item.nama, qty, satuan: item.satuan, hargaBeli }],
        total,
        dibayar: bayarAktual,
        sisaUtang,
        statusBayar,
        akunId,
        jatuhTempo: '',
        petugas: currentUser.username,
        catatan: ''
      });

      if (bayarAktual > 0) {
        db.kasModal.unshift({
          id: genId('KAS'),
          tanggalJam: waktu,
          jenis: 'Keluar',
          kategori: 'Pembelian Stok Pemasok',
          akunAsal: akunId,
          akunTujuan: '',
          nominal: bayarAktual,
          noRef: noPb,
          keterangan: `Kulakan ${noPb} (${pemasok})`,
          petugas: currentUser.username
        });
      }

      saveDatabase('CREATE_PURCHASE', noPb, `Masuk ${qty} ${item.nama}`);
      showToast(`Pembelian ${noPb} tersimpan! Stok bertambah ${qty} ${esc(item.satuan)}.`, 'success');
      renderApp();
    },

    // ========================================================================
    // PELUNASAN PIUTANG / UTANG (BAB 09 — LENGKAP DENGAN Pembayaran_Tagihan)
    // ========================================================================
    openPayModal(jenis, noRef, sisa) {
      openModal(`
        <div class="glass-card rounded-2xl p-6 max-w-sm w-full space-y-3 text-xs">
          <h3 class="text-sm font-extrabold text-white">Catat Pelunasan ${esc(noRef)}</h3>
          <p class="text-slate-300">Sisa Tagihan Saat Ini: <b class="text-rose-400 font-mono-num">${rp(sisa)}</b></p>
          <form onsubmit="window.AZI.submitPelunasan(event, '${esc(jenis)}', '${esc(noRef)}', ${Number(sisa) || 0})" class="space-y-3">
            <div>
              <label class="block text-[10px] text-slate-400 mb-1">Nominal Pembayaran (Rp) *</label>
              <input id="pay-nominal" type="number" min="1" max="${Number(sisa) || 0}" required value="${Number(sisa) || 0}" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-emerald-500/50 text-emerald-300 font-mono-num font-bold" />
            </div>
            <div>
              <label class="block text-[10px] text-slate-400 mb-1">Akun Kas / Bank *</label>
              <select id="pay-akun" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                ${db.akunKas.map((a) => `<option value="${esc(a.id)}">${esc(a.nama)} (${esc(a.tipe)})</option>`).join('')}
              </select>
            </div>
            <input id="pay-ref-tf" type="text" placeholder="Ref Transfer / QRIS (Opsional)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
            <input id="pay-catatan" type="text" placeholder="Catatan Pembayaran (Opsional)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
            <div class="flex gap-2">
              <button type="submit" class="flex-1 py-2.5 rounded-xl btn-luxury">Simpan Pelunasan</button>
              <button type="button" onclick="window.AZI.closeModal()" class="py-2.5 px-4 rounded-xl bg-slate-800 text-slate-300">Batal</button>
            </div>
          </form>
        </div>
      `);
    },

    submitPelunasan(e, jenis, noRef, sisaMaks) {
      e.preventDefault();
      const nominal = Number(document.getElementById('pay-nominal').value) || 0;
      const akunId = document.getElementById('pay-akun').value;
      const refTransfer = ((document.getElementById('pay-ref-tf') && document.getElementById('pay-ref-tf').value) || '').trim();
      const catatan = ((document.getElementById('pay-catatan') && document.getElementById('pay-catatan').value) || '').trim();
      const akunObj = db.akunKas.find((a) => a.id === akunId) || db.akunKas[0];
      if (nominal <= 0 || nominal > sisaMaks) {
        showToast('Nominal pelunasan tidak boleh melebihi sisa tagihan!', 'error');
        return;
      }

      const waktu = nowStr();

      if (jenis === 'SERVIS') {
        const s = db.servis.find((x) => x.no === noRef);
        if (!s) return;
        const sudahSebelumnya = Number(s.totalTerbayar) || 0;
        const totalAwal = Number(s.totalBiayaFinal || s.estimasiBiaya) || 0;
        s.totalTerbayar = sudahSebelumnya + nominal;
        s.sisaTagihan = Math.max(0, s.sisaTagihan - nominal);
        s.statusBayar = s.sisaTagihan === 0 ? 'Lunas' : 'DP/Sebagian';
        db.kasModal.unshift({
          id: genId('KAS'),
          tanggalJam: waktu,
          jenis: 'Masuk',
          kategori: 'Pelunasan Piutang Servis',
          akunAsal: '',
          akunTujuan: akunId,
          nominal,
          noRef,
          keterangan: `Pelunasan Servis ${noRef} (${s.pelanggan})`,
          petugas: currentUser.username
        });
        db.pembayaranTagihan.unshift({
          id: genId('PAY'),
          tanggalJam: waktu,
          jenis: 'Pelunasan Servis',
          noRef,
          pihak: s.pelanggan,
          totalAwal,
          sudahDibayar: sudahSebelumnya,
          nominal,
          sisaAkhir: s.sisaTagihan,
          metode: akunObj.tipe,
          akunId,
          refTransfer,
          statusKonfirmasi: 'Terkonfirmasi',
          petugas: currentUser.username,
          catatan: catatan || `Pelunasan servis ${noRef}`
        });
      } else if (jenis === 'PENJUALAN') {
        const p = db.penjualan.find((x) => x.no === noRef);
        if (!p) return;
        const sudahSebelumnya = Number(p.jumlahTerbayar) || 0;
        p.jumlahTerbayar = sudahSebelumnya + nominal;
        p.sisaPiutang = Math.max(0, p.sisaPiutang - nominal);
        p.statusBayar = p.sisaPiutang === 0 ? 'Lunas' : 'DP/Sebagian';
        db.kasModal.unshift({
          id: genId('KAS'),
          tanggalJam: waktu,
          jenis: 'Masuk',
          kategori: 'Pelunasan Piutang Penjualan',
          akunAsal: '',
          akunTujuan: akunId,
          nominal,
          noRef,
          keterangan: `Pelunasan Penjualan ${noRef} (${p.pelanggan})`,
          petugas: currentUser.username
        });
        db.pembayaranTagihan.unshift({
          id: genId('PAY'),
          tanggalJam: waktu,
          jenis: 'Pelunasan Penjualan',
          noRef,
          pihak: p.pelanggan,
          totalAwal: Number(p.totalAkhir) || 0,
          sudahDibayar: sudahSebelumnya,
          nominal,
          sisaAkhir: p.sisaPiutang,
          metode: akunObj.tipe,
          akunId,
          refTransfer,
          statusKonfirmasi: 'Terkonfirmasi',
          petugas: currentUser.username,
          catatan: catatan || `Pelunasan penjualan ${noRef}`
        });
      } else if (jenis === 'PEMBELIAN') {
        const pb = db.pembelian.find((x) => x.no === noRef);
        if (!pb) return;
        const sudahSebelumnya = Number(pb.dibayar) || 0;
        pb.dibayar = sudahSebelumnya + nominal;
        pb.sisaUtang = Math.max(0, pb.sisaUtang - nominal);
        pb.statusBayar = pb.sisaUtang === 0 ? 'Lunas' : 'Sebagian';
        db.kasModal.unshift({
          id: genId('KAS'),
          tanggalJam: waktu,
          jenis: 'Keluar',
          kategori: 'Pelunasan Utang Pemasok',
          akunAsal: akunId,
          akunTujuan: '',
          nominal,
          noRef,
          keterangan: `Bayar Utang ${noRef} (${pb.pemasok})`,
          petugas: currentUser.username
        });
        db.pembayaranTagihan.unshift({
          id: genId('PAY'),
          tanggalJam: waktu,
          jenis: 'Pelunasan Utang Pemasok',
          noRef,
          pihak: pb.pemasok,
          totalAwal: Number(pb.total) || 0,
          sudahDibayar: sudahSebelumnya,
          nominal,
          sisaAkhir: pb.sisaUtang,
          metode: akunObj.tipe,
          akunId,
          refTransfer,
          statusKonfirmasi: 'Terkonfirmasi',
          petugas: currentUser.username,
          catatan: catatan || `Bayar utang pembelian ${noRef}`
        });
      }

      saveDatabase('PAY_BILL', noRef, `${jenis} ${rp(nominal)}`);
      closeModal();
      showToast(`Pelunasan ${noRef} sebesar ${rp(nominal)} berhasil dicatat!`, 'success');
      renderApp();
    },

    // ========================================================================
    // KAS & MODAL (BAB 12)
    // ========================================================================
    toggleKasTransferUI() {
      const katEl = document.getElementById('kas-kategori');
      const asalWrap = document.getElementById('kas-asal-wrap');
      const tujuanWrap = document.getElementById('kas-tujuan-wrap');
      const asalEl = document.getElementById('kas-asal');
      const tujuanEl = document.getElementById('kas-tujuan');
      if (!katEl || !asalEl || !tujuanEl) return;
      const jenisRaw = katEl.value.split('|')[0];
      const needAsal = jenisRaw === 'KELUAR' || jenisRaw === 'TRANSFER';
      const needTujuan = jenisRaw === 'MASUK' || jenisRaw === 'TRANSFER';
      asalEl.disabled = !needAsal;
      tujuanEl.disabled = !needTujuan;
      if (asalWrap) asalWrap.className = needAsal ? '' : 'opacity-40 pointer-events-none';
      if (tujuanWrap) tujuanWrap.className = needTujuan ? '' : 'opacity-40 pointer-events-none';
    },

    submitKasModal(e) {
      e.preventDefault();
      const rawKat = document.getElementById('kas-kategori').value.split('|');
      const jenisRaw = rawKat[0];
      const kategori = rawKat[1];
      const akunAsal = document.getElementById('kas-asal').value;
      const akunTujuan = document.getElementById('kas-tujuan').value;
      const nominal = Number(document.getElementById('kas-nominal').value) || 0;
      const keterangan = document.getElementById('kas-ket').value.trim();

      if (nominal <= 0) {
        showToast('Nominal mutasi kas harus lebih dari 0!', 'error');
        return;
      }
      if (jenisRaw === 'TRANSFER' && akunAsal === akunTujuan) {
        showToast('Transfer antar akun harus memilih Akun Asal dan Akun Tujuan yang berbeda!', 'error');
        return;
      }

      db.kasModal.unshift({
        id: genId('KAS'),
        tanggalJam: nowStr(),
        jenis: jenisRaw === 'MASUK' ? 'Masuk' : (jenisRaw === 'KELUAR' ? 'Keluar' : 'Transfer'),
        kategori,
        akunAsal: jenisRaw === 'MASUK' ? '' : akunAsal,
        akunTujuan: jenisRaw === 'KELUAR' ? '' : akunTujuan,
        nominal,
        noRef: 'MANUAL',
        keterangan,
        petugas: currentUser.username
      });
      saveDatabase('KAS_ENTRY', kategori, rp(nominal));
      showToast('Transaksi Kas & Modal berhasil dicatat!', 'success');
      renderApp();
    },

    // ========================================================================
    // RETUR & KOREKSI (BAB 13 — STOK RIWAYAT + REFUND KAS / POTONG TAGIHAN)
    // ========================================================================
    submitRetur(e) {
      e.preventDefault();
      if (!currentUser.akses.batal_retur_refund && currentUser.jabatan !== 'Pemilik') {
        showToast('Akses ditolak: Anda tidak memiliki izin Retur / Refund!', 'error');
        return;
      }
      const jenis = document.getElementById('ret-jenis').value;
      const noAsal = document.getElementById('ret-noref').value.trim().toUpperCase();
      const sku = document.getElementById('ret-sku').value;
      const qty = Math.max(1, Number(document.getElementById('ret-qty').value) || 1);
      const layak = document.getElementById('ret-layak').value === 'YA';
      const metodePenyelesaian = document.getElementById('ret-metode').value;
      const nominal = Math.max(0, Number(document.getElementById('ret-nominal').value) || 0);
      const akunId = document.getElementById('ret-akun').value;
      const alasan = document.getElementById('ret-alasan').value.trim();

      const item = db.barang.find((b) => b.sku === sku);
      if (!item) return;

      const waktu = nowStr();
      const sebelum = getStokAkhir(item);

      if (jenis === 'Retur Pembelian' && sebelum < qty) {
        showToast(`Retur pembelian ditolak: Stok tersedia (${sebelum}) kurang dari jumlah retur (${qty})!`, 'error');
        return;
      }

      if (jenis === 'Retur Penjualan') {
        if (layak) {
          item.masuk = (Number(item.masuk) || 0) + qty;
          db.riwayatStok.unshift({
            id: genId('MUT'),
            waktu,
            sku: item.sku,
            nama: item.nama,
            jenis: 'Retur Penjualan (Layak)',
            ref: noAsal,
            masuk: qty,
            keluar: 0,
            sebelum,
            sesudah: getStokAkhir(item),
            modalSatuan: item.hargaModal,
            alasan,
            petugas: currentUser.username
          });
        }
        if (nominal > 0) {
          if (metodePenyelesaian === 'Potong Tagihan') {
            const p = db.penjualan.find((x) => x.no === noAsal);
            if (p && p.sisaPiutang > 0) {
              p.sisaPiutang = Math.max(0, p.sisaPiutang - nominal);
              p.statusBayar = p.sisaPiutang === 0 ? 'Lunas' : 'DP/Sebagian';
            }
          } else {
            db.kasModal.unshift({
              id: genId('KAS'),
              tanggalJam: waktu,
              jenis: 'Keluar',
              kategori: 'Refund Retur Penjualan',
              akunAsal: akunId,
              akunTujuan: '',
              nominal,
              noRef: noAsal,
              keterangan: `Retur Penjualan ${noAsal} (${alasan})`,
              petugas: currentUser.username
            });
          }
        }
      } else {
        item.keluar = (Number(item.keluar) || 0) + qty;
        db.riwayatStok.unshift({
          id: genId('MUT'),
          waktu,
          sku: item.sku,
          nama: item.nama,
          jenis: 'Retur Pembelian ke Pemasok',
          ref: noAsal,
          masuk: 0,
          keluar: qty,
          sebelum,
          sesudah: getStokAkhir(item),
          modalSatuan: item.hargaModal,
          alasan,
          petugas: currentUser.username
        });
        if (nominal > 0) {
          if (metodePenyelesaian === 'Potong Tagihan') {
            const pb = db.pembelian.find((x) => x.no === noAsal);
            if (pb && pb.sisaUtang > 0) {
              pb.sisaUtang = Math.max(0, pb.sisaUtang - nominal);
              pb.statusBayar = pb.sisaUtang === 0 ? 'Lunas' : 'Sebagian';
            }
          } else {
            db.kasModal.unshift({
              id: genId('KAS'),
              tanggalJam: waktu,
              jenis: 'Masuk',
              kategori: 'Refund Retur Pembelian',
              akunAsal: '',
              akunTujuan: akunId,
              nominal,
              noRef: noAsal,
              keterangan: `Retur Pembelian ${noAsal} (${alasan})`,
              petugas: currentUser.username
            });
          }
        }
      }

      db.returKoreksi.unshift({
        id: genId('RET'),
        tanggalJam: waktu,
        jenis,
        noAsal,
        sku,
        namaBarang: item.nama,
        qty,
        layak,
        nilaiOmzet: jenis === 'Retur Penjualan' ? nominal : 0,
        nilaiModal: jenis === 'Retur Penjualan' && layak ? qty * item.hargaModal : 0,
        metodePenyelesaian,
        nominalPenyelesaian: nominal,
        akunId: metodePenyelesaian === 'Refund Kas' ? akunId : '',
        alasan,
        petugas: currentUser.username
      });
      saveDatabase('CREATE_RETUR', noAsal, `${jenis} ${sku} x${qty}`);
      showToast('Retur dan koreksi stok/kas berhasil disimpan!', 'success');
      renderApp();
    },

    // ========================================================================
    // KARYAWAN & HAK AKSES (BAB 04)
    // ========================================================================
    applyRolePreset(roleName) {
      const preset = ROLE_PRESETS[roleName] || ROLE_PRESETS.Kasir;
      document.querySelectorAll('input[name="usr-menu"]').forEach((cb) => {
        cb.checked = preset.menus.includes(cb.value);
      });
      const setCb = (id, v) => { const el = document.getElementById(id); if (el) el.checked = Boolean(v); };
      setCb('perm-modal', preset.lihat_modal);
      setCb('perm-diskon', preset.ubah_harga_diskon);
      setCb('perm-laba', preset.lihat_laba);
      setCb('perm-semua', preset.semua_transaksi);
      setCb('perm-retur', preset.batal_retur_refund);
      setCb('perm-cetak', preset.cetak_ulang);
      setCb('perm-ekspor', preset.ekspor_laporan);
      setCb('perm-karyawan', preset.kelola_karyawan);
    },

    editKaryawan(username) {
      const u = db.karyawan.find((k) => k.username === username);
      if (!u) return;
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      const setCb = (id, v) => { const el = document.getElementById(id); if (el) el.checked = Boolean(v); };
      setVal('usr-nama', u.nama);
      setVal('usr-username', u.username);
      setVal('usr-kontak', u.kontak === '-' ? '' : (u.kontak || ''));
      setVal('usr-jabatan', u.jabatan);
      setVal('usr-pass', u.password);
      setCb('usr-force-change', u.wajibGantiPassword);
      document.querySelectorAll('input[name="usr-menu"]').forEach((cb) => {
        cb.checked = (u.akses && Array.isArray(u.akses.menus)) ? u.akses.menus.includes(cb.value) : false;
      });
      setCb('perm-modal', u.akses.lihat_modal);
      setCb('perm-diskon', u.akses.ubah_harga_diskon);
      setCb('perm-laba', u.akses.lihat_laba);
      setCb('perm-semua', u.akses.semua_transaksi);
      setCb('perm-retur', u.akses.batal_retur_refund);
      setCb('perm-cetak', u.akses.cetak_ulang);
      setCb('perm-ekspor', u.akses.ekspor_laporan);
      setCb('perm-karyawan', u.akses.kelola_karyawan);
      showToast(`Mode edit akun @${esc(u.username)}. Ubah hak akses lalu klik Simpan.`, 'info');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    submitKaryawan(e) {
      e.preventDefault();
      const nama = document.getElementById('usr-nama').value.trim();
      const username = document.getElementById('usr-username').value.trim().toLowerCase();
      const kontak = ((document.getElementById('usr-kontak') && document.getElementById('usr-kontak').value) || '').trim() || '-';
      const jabatan = document.getElementById('usr-jabatan').value;
      const password = document.getElementById('usr-pass').value;
      const wajibGantiPassword = document.getElementById('usr-force-change').checked;

      const selectedMenus = Array.from(document.querySelectorAll('input[name="usr-menu"]:checked')).map((cb) => cb.value);
      const getCb = (id) => Boolean(document.getElementById(id) && document.getElementById(id).checked);
      const akses = {
        menus: selectedMenus.length ? selectedMenus : ['dashboard'],
        lihat_modal: getCb('perm-modal'),
        ubah_harga_diskon: getCb('perm-diskon'),
        lihat_laba: getCb('perm-laba'),
        semua_transaksi: getCb('perm-semua'),
        batal_retur_refund: getCb('perm-retur'),
        cetak_ulang: getCb('perm-cetak'),
        ekspor_laporan: getCb('perm-ekspor'),
        kelola_karyawan: getCb('perm-karyawan')
      };

      const existing = db.karyawan.find((u) => u.username === username);
      // Cegah Pemilik terakhir menghapus akses kelola_karyawan dari dirinya sendiri
      const activeOwners = db.karyawan.filter((u) => u.jabatan === 'Pemilik' && u.aktif);
      if (existing && existing.jabatan === 'Pemilik' && activeOwners.length <= 1) {
        if (jabatan !== 'Pemilik' || !akses.kelola_karyawan || !akses.menus.includes('karyawan')) {
          showToast('Tidak dapat mencabut hak akses Pemilik pada akun Pemilik terakhir!', 'error');
          return;
        }
      }
      if (existing) {
        existing.nama = nama;
        existing.kontak = kontak;
        existing.jabatan = jabatan;
        existing.password = password;
        existing.wajibGantiPassword = wajibGantiPassword;
        existing.akses = akses;
        showToast(`Akun & hak akses @${esc(username)} diperbarui!`, 'success');
      } else {
        db.karyawan.push({
          id: nextSeqNo('USR', db.karyawan, 'id', 2),
          username,
          password,
          nama,
          jabatan,
          kontak,
          aktif: true,
          wajibGantiPassword,
          akses,
          dibuatPada: nowStr()
        });
        showToast(`Akun karyawan @${esc(username)} berhasil ditambahkan!`, 'success');
      }
      saveDatabase('UPDATE_USER_ACCESS', username, jabatan);
      renderApp();
    },

    toggleUserActive(username) {
      const target = db.karyawan.find((u) => u.username === username);
      if (!target) return;
      const activeOwners = db.karyawan.filter((u) => u.jabatan === 'Pemilik' && u.aktif);
      if (target.jabatan === 'Pemilik' && target.aktif && activeOwners.length <= 1) {
        showToast('Tidak dapat menonaktifkan akun Pemilik terakhir!', 'error');
        return;
      }
      target.aktif = !target.aktif;
      saveDatabase('TOGGLE_USER_ACTIVE', username, `Aktif: ${target.aktif}`);
      showToast(`Status akun @${esc(username)} diubah menjadi ${target.aktif ? 'Aktif' : 'Nonaktif'}.`, 'info');
      renderApp();
    },

    resetUserPassword(username) {
      const target = db.karyawan.find((u) => u.username === username);
      if (!target) return;
      target.password = '123';
      target.wajibGantiPassword = true;
      saveDatabase('RESET_PASSWORD', username, 'Reset ke 123 & wajib ganti saat login');
      showToast(`Password @${esc(username)} direset ke "123" (Wajib ganti saat login).`, 'success');
    },

    // ========================================================================
    // PENGATURAN, CLOUD SYNC DUA ARAH & BACKUP/RESTORE JSON
    // ========================================================================
    saveOwnerDatabaseConfig(e) {
      e.preventDefault();
      const rawUrl = document.getElementById('cfg-sheet-url').value.trim();
      const gasUrl = document.getElementById('cfg-gas-url').value.trim();
      const match = rawUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      db.config.spreadsheetUrl = rawUrl;
      db.config.spreadsheetId = match ? match[1] : rawUrl;
      db.config.gasWebAppUrl = gasUrl;
      saveDatabase('CHANGE_OWNER_SPREADSHEET', 'SPREADSHEET', 'Update konfigurasi Spreadsheet pemilik');
      showToast('Konfigurasi Spreadsheet Pemilik berhasil disimpan!', 'success');
      renderApp();
    },

    async triggerRemoteSheetSetup() {
      if (!db.config.gasWebAppUrl) {
        showToast('Isi URL Web App Google Apps Script terlebih dahulu, atau jalankan setupDatabaseOtomatis() di Code.gs!', 'warn');
        return;
      }
      showToast('Mengirim perintah pembuatan 12 Sheet & Header otomatis...', 'info');
      await syncToGoogleSheets('AUTO_SETUP_SHEETS', '12_SHEETS', 'Setup otomatis 12 sheet & header kolom', true);
      renderApp();
    },

    async pushAllToSheets() {
      if (!db.config.gasWebAppUrl) {
        showToast('Isi URL Web App Google Apps Script di atas terlebih dahulu!', 'warn');
        return;
      }
      showToast('Mengirim seluruh 12 Sheet data ke Google Spreadsheet...', 'info');
      await syncToGoogleSheets('MANUAL_PUSH_ALL', '12_SHEETS', 'Sinkronisasi manual seluruh data', true);
      renderApp();
    },

    pullFromGoogleSheets,

    saveStoreProfile(e) {
      e.preventDefault();
      db.config.namaToko = document.getElementById('cfg-nama').value.trim();
      db.config.kontak = document.getElementById('cfg-kontak').value.trim();
      db.config.tagline = (document.getElementById('cfg-tagline').value || '').trim();
      db.config.alamat = document.getElementById('cfg-alamat').value.trim();
      db.config.footerNota = (document.getElementById('cfg-footer').value || '').trim();
      db.config.lebarPrinter = document.getElementById('cfg-printer').value;
      saveDatabase('UPDATE_STORE_PROFILE', db.config.namaToko, db.config.lebarPrinter);
      showToast('Profil toko, footer nota & ukuran kertas thermal disimpan!', 'success');
      renderApp();
    },

    editAkunKas(accId) {
      const a = db.akunKas.find((x) => x.id === accId);
      if (!a) return;
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      setVal('acc-id', a.id);
      setVal('acc-nama', a.nama);
      setVal('acc-tipe', a.tipe);
      setVal('acc-saldo', Number(a.saldoAwal) || 0);
      showToast(`Mode edit akun kas "${esc(a.nama)}". Ubah data lalu klik Simpan.`, 'info');
    },

    submitAkunKas(e) {
      e.preventDefault();
      const accId = (document.getElementById('acc-id').value || '').trim();
      const nama = document.getElementById('acc-nama').value.trim();
      const tipe = document.getElementById('acc-tipe').value;
      const saldoAwal = Math.max(0, Number(document.getElementById('acc-saldo').value) || 0);
      if (!nama) return;

      const existing = accId ? db.akunKas.find((x) => x.id === accId) : null;
      if (existing) {
        existing.nama = nama;
        existing.tipe = tipe;
        existing.saldoAwal = saldoAwal;
        saveDatabase('UPDATE_CASH_ACCOUNT', existing.id, `${nama} (${rp(saldoAwal)})`);
        showToast(`Akun kas "${esc(nama)}" berhasil diperbarui!`, 'success');
      } else {
        const newId = 'ACC-' + nama.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) + '-' + String(db.akunKas.length + 1);
        db.akunKas.push({ id: newId, nama, tipe, saldoAwal, aktif: true });
        saveDatabase('CREATE_CASH_ACCOUNT', newId, `${nama} (${rp(saldoAwal)})`);
        showToast(`Akun kas baru "${esc(nama)}" ditambahkan!`, 'success');
      }
      renderApp();
    },

    exportBackupJson() {
      const jsonStr = JSON.stringify(db, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Backup_AziCell_${todayStr()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('File cadangan JSON berhasil diunduh!', 'success');
    },

    importBackupJson(event) {
      const file = event.target && event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const parsed = JSON.parse(String(ev.target.result || '{}'));
          if (!parsed || !Array.isArray(parsed.karyawan) || !Array.isArray(parsed.barang)) {
            showToast('File JSON tidak valid untuk database Azi Cell!', 'error');
            return;
          }
          db = migrateDatabase(parsed);
          saveDatabase('RESTORE_BACKUP_JSON', file.name, 'Pulihkan database dari file backup JSON');
          showToast('Database berhasil dipulihkan dari file backup JSON!', 'success');
          renderApp();
        } catch (err) {
          showToast('Gagal membaca file JSON backup.', 'error');
        }
      };
      reader.readAsText(file);
    },

    // ========================================================================
    // PRINTER THERMAL BLUETOOTH ENGINE (POJOK KANAN ATAS: MERAH / HIJAU)
    // ========================================================================
    handleBluetoothButtonClick() {
      const isConn = bluetoothStatus === 'connected' && Boolean(bluetoothCharacteristic);
      if (isConn) {
        this.openBluetoothStatusModal();
      } else {
        this.connectBluetoothPrinter();
      }
    },

    openBluetoothStatusModal() {
      const isConn = bluetoothStatus === 'connected' && Boolean(bluetoothCharacteristic);
      openModal(`
        <div class="glass-card rounded-2xl p-6 max-w-sm w-full space-y-4 text-xs border ${isConn ? 'border-emerald-500/40' : 'border-rose-500/40'}">
          <div class="flex items-center justify-between border-b border-slate-800 pb-2.5">
            <div class="flex items-center gap-2">
              <span class="w-3 h-3 rounded-full ${isConn ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}"></span>
              <h3 class="text-sm font-extrabold text-white">Printer Thermal Bluetooth</h3>
            </div>
            <button onclick="window.AZI.closeModal()" class="text-slate-400 hover:text-white text-xl">&times;</button>
          </div>
          <div class="p-3.5 rounded-xl bg-slate-900 border border-slate-800 space-y-1.5">
            <div class="flex justify-between"><span class="text-slate-400">Status:</span><b class="${isConn ? 'text-emerald-400' : 'text-rose-400'}">${isConn ? 'TERHUBUNG (HIJAU)' : 'BELUM KONEK (MERAH)'}</b></div>
            <div class="flex justify-between"><span class="text-slate-400">Perangkat:</span><b class="text-white">${esc(bluetoothDeviceName || '-')}</b></div>
            <div class="flex justify-between"><span class="text-slate-400">Lebar Kertas:</span><b class="text-amber-300">${esc(db.config.lebarPrinter)}</b></div>
          </div>
          <div class="space-y-2">
            <button type="button" onclick="window.AZI.testPrintThermal()" class="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold">🧾 Tes Cetak Struk</button>
            <button type="button" onclick="window.AZI.closeModal(); window.AZI.connectBluetoothPrinter();" class="w-full py-2.5 rounded-xl btn-cyber">🔄 Ganti / Sambung Ulang Printer</button>
            ${isConn ? `<button type="button" onclick="window.AZI.disconnectBluetoothPrinter(); window.AZI.closeModal();" class="w-full py-2.5 rounded-xl bg-rose-950 hover:bg-rose-900 border border-rose-500/40 text-rose-200 font-bold">🔌 Putuskan Koneksi Bluetooth</button>` : ''}
          </div>
        </div>
      `);
    },

    async connectBluetoothPrinter() {
      if (!navigator.bluetooth) {
        bluetoothStatus = 'disconnected';
        updateBluetoothUiBadges();
        showToast('Browser ini belum mendukung Web Bluetooth langsung (gunakan Chrome/Edge Android atau Windows, atau cetak lewat tombol Cetak Sistem/PDF).', 'warn');
        return false;
      }
      bluetoothStatus = 'connecting';
      updateBluetoothUiBadges();
      try {
        const device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: BLE_PRINTER_SERVICES
        });

        bluetoothDevice = device;
        bluetoothDeviceName = device.name || 'Printer Thermal';

        // Pasang listener otomatis saat printer mati / terputus -> indikator langsung berubah MERAH!
        device.addEventListener('gattserverdisconnected', () => {
          bluetoothCharacteristic = null;
          bluetoothStatus = 'disconnected';
          updateBluetoothUiBadges();
          showToast(`Koneksi Printer Bluetooth (${esc(bluetoothDeviceName)}) terputus!`, 'warn');
        });

        const server = await device.gatt.connect();
        let writableChar = null;

        // Coba telusuri semua service yang tersedia di printer
        try {
          const services = await server.getPrimaryServices();
          for (const svc of services) {
            try {
              const chars = await svc.getCharacteristics();
              const found = chars.find((c) => c.properties.writeWithoutResponse) || chars.find((c) => c.properties.write);
              if (found) {
                writableChar = found;
                break;
              }
            } catch (e) {}
          }
        } catch (e) {
          // Fallback: cek satu per satu UUID standar thermal printer
          for (const uuid of BLE_PRINTER_SERVICES) {
            try {
              const svc = await server.getPrimaryService(uuid);
              const chars = await svc.getCharacteristics();
              const found = chars.find((c) => c.properties.writeWithoutResponse) || chars.find((c) => c.properties.write);
              if (found) {
                writableChar = found;
                break;
              }
            } catch (err) {}
          }
        }

        if (!writableChar) {
          try { if (device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch (e) {}
          bluetoothCharacteristic = null;
          bluetoothStatus = 'disconnected';
          updateBluetoothUiBadges();
          showToast('Perangkat Bluetooth ini tidak memiliki layanan cetak BLE. Pastikan memilih Printer Thermal BLE atau gunakan Cetak Sistem.', 'error');
          return false;
        }

        bluetoothCharacteristic = writableChar;
        bluetoothStatus = 'connected';
        updateBluetoothUiBadges();
        showToast(`Printer Bluetooth "${esc(bluetoothDeviceName)}" TERHUBUNG!`, 'success');
        if (activeMenu === 'pengaturan') renderApp();
        return true;
      } catch (err) {
        bluetoothStatus = bluetoothCharacteristic ? 'connected' : 'disconnected';
        updateBluetoothUiBadges();
        showToast('Koneksi Bluetooth dibatalkan atau printer memakai jalur Sistem/Classic.', 'warn');
        return false;
      }
    },

    disconnectBluetoothPrinter() {
      try {
        if (bluetoothDevice && bluetoothDevice.gatt && bluetoothDevice.gatt.connected) {
          bluetoothDevice.gatt.disconnect();
        }
      } catch (e) {}
      bluetoothCharacteristic = null;
      bluetoothStatus = 'disconnected';
      bluetoothDeviceName = '';
      updateBluetoothUiBadges();
      showToast('Koneksi Printer Bluetooth diputuskan.', 'info');
      if (activeMenu === 'pengaturan') renderApp();
    },

    async printCurrentReceiptBluetooth() {
      if (!lastReceiptBlePayload) {
        window.print();
        return;
      }
      if (!bluetoothCharacteristic || bluetoothStatus !== 'connected') {
        const connected = await this.connectBluetoothPrinter();
        if (!connected) {
          showToast('Membuka dialog Cetak Sistem sebagai metode cadangan...', 'info');
          window.print();
          return;
        }
      }
      await this.printViaBluetooth(lastReceiptBlePayload);
    },

    async printViaBluetooth(rawText) {
      if (!bluetoothCharacteristic || bluetoothStatus !== 'connected') {
        showToast('Printer BLE belum terhubung (Merah). Membuka dialog Cetak Sistem...', 'info');
        window.print();
        return;
      }
      try {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(rawText);
        // Kirim bertahap per 20 byte (standar MTU BLE) agar semua printer thermal tidak terpotong!
        const CHUNK_SIZE = 20;
        for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
          const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
          if (bluetoothCharacteristic.properties.writeWithoutResponse && typeof bluetoothCharacteristic.writeValueWithoutResponse === 'function') {
            await bluetoothCharacteristic.writeValueWithoutResponse(chunk);
          } else {
            await bluetoothCharacteristic.writeValue(chunk);
          }
          await new Promise((r) => setTimeout(r, 18));
        }
        showToast('Struk berhasil dicetak ke Printer Thermal Bluetooth!', 'success');
      } catch (e) {
        bluetoothCharacteristic = null;
        bluetoothStatus = 'disconnected';
        updateBluetoothUiBadges();
        showToast('Gagal kirim ke Printer Bluetooth (terputus). Membuka dialog Cetak Sistem...', 'warn');
        window.print();
      }
    },

    testPrintThermal() {
      const sample = buildEscPosReceipt({
        title: `TES CETAK PRINTER (${db.config.lebarPrinter})`,
        metaLines: [
          `Waktu    : ${nowStr()}`,
          `Printer  : ${bluetoothDeviceName || 'Thermal'}`,
          `Status   : Normal & Terbaca Jelas`
        ],
        sections: [
          {
            heading: 'CONTOH BARANG + JASA:',
            lines: [
              { name: 'LCD Touchscreen Ori Set', detailLeft: '1 x Rp80.000', detailRight: 'Rp80.000' },
              { lr: true, left: 'Jasa Pasang LCD', right: 'Rp50.000' }
            ]
          }
        ],
        summaryRows: [
          { left: 'TOTAL', right: 'Rp130.000', bold: true }
        ],
        statusBayar: 'TES OK'
      });
      this.printViaBluetooth(sample);
    },

    exportReportCsv() {
      const m = calculateFinancialMetrics();
      const csvCell = (val) => `"${String(val === null || val === undefined ? '' : val).replace(/"/g, '""')}"`;
      const rows = [
        ['LAPORAN KEUANGAN AZI CELL', `Periode: ${filterDateStart || 'Awal'} s/d ${filterDateEnd || 'Sekarang'}`],
        ['Omzet Penjualan Barang', m.omzetPenjualanBarang],
        ['Omzet Jasa Pasang (POS)', m.omzetJasaPenjualan],
        ['Omzet Jasa Servis', m.omzetJasaServis],
        ['Omzet Spare Part Servis', m.omzetSparepartServis],
        ['Retur Penjualan', -m.totalReturOmzet],
        ['Total Omzet Bersih', m.omzetBersih],
        ['Total HPP / Modal Terjual', m.totalHpp],
        ['Laba Kotor', m.labaKotor],
        ['Biaya Operasional', m.biayaOperasional],
        ['Laba Bersih Operasional', m.labaBersihOperasional],
        ['Nilai Persediaan Barang', m.nilaiPersediaan],
        ['Total Piutang Pelanggan', m.totalPiutang],
        ['Total Utang Pemasok', m.totalUtang],
        [],
        ['=== PENJUALAN ==='],
        ['No_Transaksi', 'Waktu', 'Status_Dokumen', 'Pelanggan', 'Total_Jasa', 'Diskon', 'Total_Akhir', 'Laba_Kotor', 'Status_Bayar', 'Petugas'],
        ...db.penjualan
          .filter((p) => isInDateFilter(p.tanggalJam))
          .map((p) => [p.no, p.tanggalJam, p.statusDokumen, p.pelanggan, p.totalJasa || 0, p.diskon || 0, p.totalAkhir, p.labaKotor, p.statusBayar, p.petugas]),
        [],
        ['=== SERVIS ==='],
        ['No_Servis', 'Tanggal_Terima', 'Pelanggan', 'Perangkat', 'Status_Kerja', 'Total_Sparepart', 'Biaya_Jasa', 'Diskon', 'Total_Final', 'Sudah_Bayar', 'Sisa_Tagihan', 'Status_Bayar'],
        ...db.servis
          .filter((s) => isInDateFilter(s.tanggalTerima))
          .map((s) => [s.no, s.tanggalTerima, s.pelanggan, s.merekModel, s.statusPengerjaan, s.totalSparepart, s.biayaJasa, s.diskon || 0, s.totalBiayaFinal, s.totalTerbayar, s.sisaTagihan, s.statusBayar])
      ];
      const csv = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Laporan_AziCell_${todayStr()}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Laporan CSV lengkap berhasil diunduh!', 'success');
    }
  };

  function renderApp() {
    const root = document.getElementById('app-root');
    if (!root) return;
    root.innerHTML = currentUser ? renderMainLayout() : renderLoginView();
  }

  // Jalankan aplikasi & pengecekan Auto-Update Service Worker
  initServiceWorkerAndAutoUpdate();
  renderApp();

  // Pada perangkat baru (belum ada localStorage), tarik data terbaru dari Google Spreadsheet jika tersedia
  if (isFreshDeviceBoot && db.config.gasWebAppUrl) {
    pullFromGoogleSheets({ silent: true, onlyIfHasData: true });
  }
})();