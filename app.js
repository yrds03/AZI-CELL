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
  const LOGIN_GUARD_KEY = 'AZICELL_LOGIN_GUARD_V1';
  const SESSION_IDLE_MS = 8 * 60 * 60 * 1000; // Auto-logout setelah 8 jam tidak aktif
  const PWD_SALT = 'AZICELL_SEC_2026_V1:';

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
  let localMutationEpoch = 0;
  let initialCloudPullPromise = null;
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

  // Escaping khusus literal string JS di dalam atribut HTML onclick="fn('...')"
  function escJs(val) {
    const jsSafe = String(val === null || val === undefined ? '' : val)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\r/g, '')
      .replace(/\n/g, ' ');
    return esc(jsSafe);
  }

  // Pure-JS SHA-256 standar FIPS 180-4 (bekerja sinkron & offline tanpa dependensi eksternal)
  function sha256Hex(input) {
    const bytes = new TextEncoder().encode(String(input));
    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    const bitLen = bytes.length * 8;
    const totalLen = Math.ceil((bytes.length + 9) / 64) * 64;
    const buf = new Uint8Array(totalLen);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    const view = new DataView(buf.buffer);
    view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);
    view.setUint32(totalLen - 4, bitLen >>> 0, false);

    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    const w = new Uint32Array(64);
    for (let offset = 0; offset < totalLen; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ ((~e) & g);
        const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, '0')).join('');
  }

  function hashPassword(plain) {
    const s = String(plain || '');
    if (s.startsWith('sha256:')) return s;
    return 'sha256:' + sha256Hex(PWD_SALT + s);
  }

  function verifyPassword(plain, stored) {
    const st = String(stored || '');
    const inp = String(plain || '');
    if (!st) return false;
    if (st.startsWith('sha256:')) {
      return st === ('sha256:' + sha256Hex(PWD_SALT + inp));
    }
    return st === inp;
  }

  function isDefaultWeakPassword(stored) {
    return verifyPassword('123', stored);
  }

  function stripProtoKeys(obj) {
    if (Array.isArray(obj)) return obj.map(stripProtoKeys);
    if (obj && typeof obj === 'object') {
      const clean = {};
      Object.keys(obj).forEach((k) => {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
        clean[k] = stripProtoKeys(obj[k]);
      });
      return clean;
    }
    return obj;
  }

  function canManageStock() {
    return Boolean(currentUser && (currentUser.akses.lihat_modal || currentUser.jabatan === 'Pemilik' || currentUser.jabatan === 'Gudang'));
  }

  function requirePerm(cond, msg) {
    if (!currentUser || !cond) {
      showToast(msg || 'Akses ditolak: Akun Anda tidak memiliki izin untuk tindakan ini.', 'error');
      return false;
    }
    return true;
  }

  function getLoginGuard() {
    try {
      const raw = localStorage.getItem(LOGIN_GUARD_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { fails: 0, lockUntil: 0 };
  }

  function setLoginGuard(guard) {
    try { localStorage.setItem(LOGIN_GUARD_KEY, JSON.stringify(guard)); } catch (e) {}
  }

  // Struktur Database Awal Bersih (Siap Produksi — Bebas Data Dummy, sinkron 2 akun bawaan Code.gs)
  function createInitialDatabase() {
    const now = nowStr();
    return {
      config: {
        spreadsheetId: window.AZI_CONFIG.SPREADSHEET_ID,
        spreadsheetUrl: window.AZI_CONFIG.SPREADSHEET_URL,
        gasWebAppUrl: window.AZI_CONFIG.GAS_WEB_APP_URL || '',
        ...window.AZI_CONFIG.STORE_PROFILE
      },
      karyawan: [
        { id: 'USR-01', username: 'owner', password: hashPassword('123'), nama: 'Pemilik Azi Cell', jabatan: 'Pemilik', kontak: '081234567890', aktif: true, wajibGantiPassword: false, akses: JSON.parse(JSON.stringify(ROLE_PRESETS.Pemilik)), dibuatPada: now },
        { id: 'USR-02', username: 'kasir', password: hashPassword('123'), nama: 'Kasir Azi Cell', jabatan: 'Kasir', kontak: '081299991111', aktif: true, wajibGantiPassword: false, akses: JSON.parse(JSON.stringify(ROLE_PRESETS.Kasir)), dibuatPada: now }
      ],
      akunKas: [
        { id: 'ACC-TUNAI', nama: 'Kas Tunai Laci', tipe: 'Tunai', saldoAwal: 0, aktif: true },
        { id: 'ACC-BANK', nama: 'Bank BCA Operasional', tipe: 'Transfer', saldoAwal: 0, aktif: true },
        { id: 'ACC-QRIS', nama: 'Saldo Penampungan QRIS', tipe: 'QRIS', saldoAwal: 0, aktif: true }
      ],
      barang: [],
      riwayatStok: [],
      pembelian: [],
      penjualan: [],
      servis: [],
      pembayaranTagihan: [],
      kasModal: [],
      returKoreksi: [],
      logAudit: []
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

  // State Pencarian Live di Semua Menu & Anti-Human-Error
  let globalSearchQuery = '';
  let salesHistoryQuery = '';
  let servisSearchQuery = '';
  let stokSearchQuery = '';
  let mutasiSearchQuery = '';
  let pembelianSearchQuery = '';
  let pembayaranSearchQuery = '';
  let kasSearchQuery = '';
  let pbSelectedSku = (db.barang[0] && db.barang[0].sku) || '';
  let pbItemSearchQuery = '';
  let editingBarangSku = '';
  let editingServiceDraft = null;
  let lastReceiptBleCopy2 = null;
  let lastReceiptMeta = null;
  let pendingConfirmFn = null;

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

  function saveLocalOnly(auditAction, auditTarget, auditDetail) {
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
  }

  function saveDatabase(auditAction, auditTarget, auditDetail) {
    localMutationEpoch += 1;
    saveLocalOnly(auditAction, auditTarget, auditDetail);
    syncToGoogleSheets(auditAction, auditTarget, auditDetail);
  }

  function loadSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const sess = JSON.parse(raw);
      if (sess.lastActiveAt && (Date.now() - Number(sess.lastActiveAt)) > SESSION_IDLE_MS) {
        sessionStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
      const found = db.karyawan.find((u) => u.username === sess.username && u.aktif);
      if (found) {
        const refreshed = JSON.stringify({ username: found.username, lastActiveAt: Date.now() });
        sessionStorage.setItem(SESSION_KEY, refreshed);
        localStorage.setItem(SESSION_KEY, refreshed);
      }
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
    const payload = JSON.stringify({ username: user.username, lastActiveAt: Date.now() });
    sessionStorage.setItem(SESSION_KEY, payload);
    localStorage.setItem(SESSION_KEY, payload);
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
    el.textContent = String(msg || '');
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
    const gasUrl = (db.config.gasWebAppUrl || '').trim();
    if (!gasUrl) {
      if (!silent) showToast('URL Web App Google Apps Script belum diisi di menu Pengaturan!', 'warn');
      return { ok: false, skipped: true };
    }
    const epochAtStart = localMutationEpoch;
    if (!silent) showToast('Menarik data terbaru dari 12 Sheet Google Spreadsheet...', 'info');
    try {
      const sep = gasUrl.includes('?') ? '&' : '?';
      const url = `${gasUrl}${sep}action=pull&spreadsheetId=${encodeURIComponent(db.config.spreadsheetId || '')}&_ts=${Date.now()}`;
      const resp = await fetch(url, { method: 'GET', cache: 'no-store' });
      const json = await resp.json();
      if (json && json.status === 'PULL_SUCCESS' && json.data) {
        // Cegah pull latar belakang menimpa transaksi baru yang baru saja disimpan pengguna
        if (silent && localMutationEpoch !== epochAtStart) {
          return { ok: false, stale: true };
        }
        const currentGasUrl = db.config.gasWebAppUrl;
        const currentSheetUrl = db.config.spreadsheetUrl;
        const pulled = migrateDatabase(json.data);
        pulled.config.gasWebAppUrl = currentGasUrl;
        if (!pulled.config.spreadsheetUrl) pulled.config.spreadsheetUrl = currentSheetUrl;
        db = pulled;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));

        // Selaraskan state aktif dengan data terbaru dari Google Sheet (termasuk jika data dihapus/kosong)
        if (!db.barang.some((b) => b.sku === pbSelectedSku)) {
          pbSelectedSku = (db.barang[0] && db.barang[0].sku) || '';
        }
        if (!db.akunKas.some((a) => a.id === posAccountId)) {
          posAccountId = (db.akunKas[0] && db.akunKas[0].id) || 'ACC-TUNAI';
        }
        posCart = posCart.filter((c) => db.barang.some((b) => b.sku === c.sku && b.aktif));
        if (currentUser) {
          const freshUser = db.karyawan.find((u) => u.username === currentUser.username && u.aktif);
          if (freshUser) {
            currentUser = freshUser;
          } else {
            saveSession(null);
          }
        }

        cloudSyncState = { status: 'ok', lastSyncedAt: nowStr(), message: 'Tersinkron dari Spreadsheet' };
        if (!silent) showToast('Data terbaru berhasil ditarik dari Google Spreadsheet!', 'success');
        renderApp();
        return { ok: true };
      } else if (!silent) {
        showToast('Gagal tarik data: ' + ((json && json.message) || 'Pastikan Code.gs sudah versi terbaru & di-deploy ulang.'), 'error');
      }
      return { ok: false };
    } catch (err) {
      if (!silent) {
        showToast('Tidak dapat menarik data dari Spreadsheet. Pastikan Web App diakses "Anyone" & koneksi internet aktif.', 'error');
      }
      return { ok: false, error: err };
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
        ? '<span>🖨️</span><span>Cetak 1x Bluetooth</span>'
        : '<span>🖨️</span><span>Konek & Cetak 1x BT</span>';
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
    pendingConfirmFn = null;
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
              <div class="relative">
                <input id="login-password" type="password" required autocomplete="current-password" placeholder="Masukkan password..." class="w-full px-4 py-3 pr-11 rounded-xl bg-slate-900/90 border border-slate-700/80 text-white text-sm focus:outline-none focus:border-amber-400" />
                <button type="button" onclick="window.AZI.toggleLoginPassword()" title="Tampilkan / Sembunyikan Password" class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-amber-300 text-sm px-1">👁️</button>
              </div>
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

          <!-- Catatan Keamanan (Tidak membocorkan username/password ke publik) -->
          <div class="mt-6 pt-4 border-t border-slate-800/80 text-center space-y-1">
            <div class="text-[11px] font-semibold text-emerald-400/90 flex items-center justify-center gap-1.5">
              <span>🔒</span>
              <span>Dilindungi Enkripsi SHA-256 & Proteksi Brute-Force</span>
            </div>
            <p class="text-[10px] text-slate-500">Akses khusus staf resmi ${esc(db.config.namaToko)}. Hubungi Pemilik jika lupa kata sandi.</p>
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
                ${(db.config.gasWebAppUrl || '').trim() ? `
                  <button type="button" onclick="window.AZI.syncNowFromCloud()" title="Tarik data terbaru dari Google Spreadsheet${cloudSyncState.lastSyncedAt ? ' (Terakhir: ' + esc(cloudSyncState.lastSyncedAt) + ')' : ''}" class="px-2.5 py-1.5 rounded-full bg-indigo-500/20 hover:bg-indigo-500/35 border border-indigo-400/40 text-indigo-200 font-bold text-[11px] flex items-center gap-1 transition">
                    <span>🔄</span>
                    <span class="hidden sm:inline">Sync Sheet</span>
                  </button>
                ` : ''}
                ${renderBluetoothHeaderPill()}
                <button onclick="window.AZI.logout()" class="lg:hidden px-2.5 py-1.5 rounded-full bg-rose-950/80 border border-rose-500/30 text-[11px] font-bold text-rose-200">Keluar</button>
              </div>
            </div>

            <!-- BAR PENCARIAN CEPAT GLOBAL (AUTO-SEARCH SEMUA NO. TRANSAKSI / SERVIS / PEMBELIAN / KODE BARANG) -->
            <div class="relative">
              <div class="flex items-center gap-2">
                <div class="relative flex-1">
                  <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none">🔍</span>
                  <input
                    id="global-quick-search"
                    type="text"
                    value="${esc(globalSearchQuery)}"
                    oninput="window.AZI.handleGlobalSearch(this.value)"
                    onfocus="window.AZI.handleGlobalSearch(this.value)"
                    placeholder="Cari cepat di semua menu: ketik No. Transaksi (PJ-), No. Servis (SRV-), No. Beli (PB-), Kode SKU / Barcode, Nama..."
                    autocomplete="off"
                    class="w-full pl-8 pr-8 py-2 rounded-xl bg-slate-900/95 border border-sky-500/35 focus:border-amber-400 focus:outline-none text-xs text-white placeholder:text-slate-400"
                  />
                  <button
                    id="global-search-clear"
                    type="button"
                    onclick="window.AZI.clearGlobalSearch()"
                    class="${globalSearchQuery ? '' : 'hidden '}absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white text-sm font-bold"
                  >&times;</button>
                </div>
              </div>
              <div id="global-search-dropdown" class="hidden absolute left-0 right-0 top-full mt-1.5 z-50 glass-card rounded-2xl border border-amber-500/40 shadow-2xl max-h-96 overflow-y-auto p-2 space-y-2"></div>
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
            <input id="new-pass-1" type="password" required minlength="4" placeholder="Password Baru" class="w-full px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-sm text-white" />
            <input id="new-pass-2" type="password" required minlength="4" placeholder="Ulangi Password Baru" class="w-full px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-sm text-white" />
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

    const weakPwd = isDefaultWeakPassword(currentUser.password);
    const lowStockItems = db.barang.filter((b) => b.aktif && getStokAkhir(b) <= (Number(b.stokMinimum) || 0));

    return `
      ${weakPwd ? `
        <div class="p-3.5 rounded-2xl bg-amber-950/60 border border-amber-500/50 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div class="text-amber-200">
            <b>⚠️ Pengingat Keamanan:</b> Akun Anda masih menggunakan password bawaan. Disarankan segera mengganti sandi agar akun toko tetap aman.
          </div>
          <button onclick="window.AZI.openChangePasswordModal()" class="px-3 py-1.5 rounded-xl btn-luxury text-[11px] shrink-0">🔐 Ganti Sandi Sekarang</button>
        </div>
      ` : ''}

      ${lowStockItems.length > 0 ? `
        <div class="p-3.5 rounded-2xl bg-rose-950/45 border border-rose-500/40 space-y-2 text-xs">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="font-extrabold text-rose-200">🚨 Peringatan Stok Menipis / Habis (${lowStockItems.length} Barang)</div>
            <span class="text-[10px] text-rose-300/80">Segera restok agar transaksi tidak terhambat</span>
          </div>
          <div class="flex flex-wrap gap-2">
            ${lowStockItems.slice(0, 6).map((b) => `
              <div class="px-2.5 py-1.5 rounded-xl bg-slate-950/80 border border-rose-500/30 flex items-center gap-2">
                <span class="font-mono-num text-[10px] text-sky-300 font-bold">${esc(b.sku)}</span>
                <span class="text-white font-semibold">${esc(b.nama)}</span>
                <span class="font-mono-num font-extrabold text-rose-400">Sisa ${getStokAkhir(b)}</span>
                ${akses.menus.includes('pembelian') ? `<button onclick="window.AZI.quickRestockFromAlert('${escJs(b.sku)}')" class="px-2 py-0.5 rounded-lg bg-emerald-600/30 hover:bg-emerald-600/50 border border-emerald-500/40 text-emerald-200 font-bold text-[10px]">+ Beli Stok</button>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

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
          <button onclick="window.AZI.addToPosCart('${escJs(b.sku)}')" ${stok <= 0 ? 'disabled' : ''} class="px-3 py-2 rounded-xl shrink-0 ${stok > 0 ? 'btn-luxury' : 'bg-slate-800 text-slate-500 cursor-not-allowed'} text-xs">
            + Keranjang
          </button>
        </div>
      `;
    }).join('');
  }

  function renderSalesHistoryRows(queryText) {
    const q = String(queryText || '').trim().toLowerCase();
    const filteredSales = db.penjualan.filter((p) => {
      if (!currentUser.akses.semua_transaksi && p.petugas !== currentUser.username) return false;
      if (!isInDateFilter(p.tanggalJam)) return false;
      if (!q) return true;
      const itemText = (p.items || []).map((i) => `${i.sku} ${i.nama}`).join(' ').toLowerCase();
      const jasaText = (p.jasaItems || []).map((j) => j.nama).join(' ').toLowerCase();
      return (
        String(p.no || '').toLowerCase().includes(q) ||
        String(p.pelanggan || '').toLowerCase().includes(q) ||
        String(p.kontak || '').toLowerCase().includes(q) ||
        String(p.statusBayar || '').toLowerCase().includes(q) ||
        itemText.includes(q) ||
        jasaText.includes(q)
      );
    });
    if (filteredSales.length === 0) {
      return `<tr><td colspan="7" class="py-6 text-center text-slate-500">Tidak ada transaksi penjualan yang cocok.</td></tr>`;
    }
    return filteredSales.map((p) => `
      <tr>
        <td class="py-2.5 font-mono-num font-bold text-amber-300">${esc(p.no)}</td>
        <td class="py-2.5 text-slate-300">${esc(p.tanggalJam)}</td>
        <td class="py-2.5">
          <div class="font-semibold text-white">${esc(p.pelanggan)}</div>
          ${(p.items && p.items.length > 0) ? `<div class="text-[10px] text-slate-400 truncate max-w-xs">${esc(p.items.map((i) => `${i.nama} (${i.qty}x)`).join(', '))}</div>` : ''}
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
            ${currentUser.akses.cetak_ulang ? `<button onclick="window.AZI.openReceiptModal('PENJUALAN', '${escJs(p.no)}')" class="px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/40 text-sky-300 font-bold text-[11px]">🧾 Cek / Print 2x</button>` : `<span class="text-[10px] text-slate-500">Cetak terkunci</span>`}
          ` : `
            <button onclick="window.AZI.finalizeDraftSale('${escJs(p.no)}')" class="px-2.5 py-1 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-bold text-[11px]">Finalisasi</button>
            <button onclick="window.AZI.deleteDraftSale('${escJs(p.no)}')" class="px-2 py-1 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-300 font-bold text-[11px]">Hapus</button>
          `}
        </td>
      </tr>
    `).join('');
  }

  function renderPenjualanView() {
    const subtotalBarang = posCart.reduce((s, i) => s + i.qty * i.hargaJual, 0);
    const totalJasa = posServices.reduce((s, j) => s + (Number(j.biaya) || 0), 0);
    const subtotal = subtotalBarang + totalJasa;
    const totalAkhir = Math.max(0, subtotal - (Number(posDiscount) || 0));
    const currentPaid = posPaidOverride !== null ? posPaidOverride : totalAkhir;
    const selisih = currentPaid - totalAkhir;

    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- KATALOG PILIH BARANG -->
        <div class="lg:col-span-7 glass-card rounded-2xl p-5 space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 class="text-sm font-extrabold text-white">Katalog Barang Siap Jual</h3>
              <p class="text-[10px] text-slate-400">Ketik SKU/Barcode lalu tekan <b>Enter</b> untuk langsung masuk keranjang.</p>
            </div>
            <input id="pos-search" type="text" value="${esc(posSearchQuery)}" oninput="window.AZI.filterPosCatalog(this.value)" onkeydown="window.AZI.handlePosSearchEnter(event)" placeholder="Scan Barcode / SKU / Nama barang..." class="px-3.5 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white w-full sm:w-64" />
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
          <h3 class="text-sm font-extrabold text-white">Riwayat Transaksi Penjualan (Cek Nota & Print 2x)</h3>
          <input id="sales-history-search" type="text" value="${esc(salesHistoryQuery)}" oninput="window.AZI.filterSalesHistory(this.value)" placeholder="🔍 Cari No. Transaksi (PJ-) / Pelanggan / Barang..." class="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white w-full sm:w-72" />
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
            <tbody id="sales-history-tbody" class="divide-y divide-slate-800/60">
              ${renderSalesHistoryRows(salesHistoryQuery)}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // BAB 08: PENERIMAAN & PENGERJAAN SERVIS (STEPPER ALUR 1-KLIK ANTI HUMAN ERROR)
  // ==========================================================================
  function renderServisCardsList(queryText) {
    const q = String(queryText || '').trim().toLowerCase();
    const list = db.servis.filter((s) => {
      if (!currentUser.akses.semua_transaksi && s.teknisi !== currentUser.username && s.petugasTerima !== currentUser.username) return false;
      if (!isInDateFilter(s.tanggalTerima)) return false;
      if (!q) return true;
      return (
        String(s.no || '').toLowerCase().includes(q) ||
        String(s.pelanggan || '').toLowerCase().includes(q) ||
        String(s.kontak || '').toLowerCase().includes(q) ||
        String(s.merekModel || '').toLowerCase().includes(q) ||
        String(s.jenisServis || '').toLowerCase().includes(q) ||
        String(s.statusPengerjaan || '').toLowerCase().includes(q)
      );
    });
    if (list.length === 0) {
      return `<p class="text-xs text-slate-500 text-center py-8">Tidak ada data servis yang cocok.</p>`;
    }
    const steps = ['Diterima', 'Dikerjakan', 'Selesai', 'Diambil'];
    return list.map((s) => {
      const stepIdx = steps.indexOf(s.statusPengerjaan);
      const isBatal = s.statusPengerjaan === 'Batal';
      return `
        <div class="p-4 rounded-2xl bg-slate-900/90 border ${s.sisaTagihan > 0 && s.statusPengerjaan === 'Selesai' ? 'border-amber-500/40' : 'border-slate-800'} space-y-2.5 text-xs">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span class="font-mono-num font-extrabold text-amber-400 text-sm">${esc(s.no)}</span>
              <span class="text-slate-400 ml-2">${esc(s.tanggalTerima)}</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold ${isBatal ? 'bg-rose-500/20 text-rose-300' : (s.statusPengerjaan === 'Selesai' || s.statusPengerjaan === 'Diambil' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-sky-500/20 text-sky-300')}">${esc(s.statusPengerjaan)}</span>
              <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold ${s.statusBayar === 'Lunas' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">${esc(s.statusBayar)}</span>
            </div>
          </div>

          ${!isBatal ? `
            <!-- STEPPER PROGRES 4 LANGKAH -->
            <div class="grid grid-cols-4 gap-1 pt-0.5">
              ${steps.map((st, idx) => `
                <div class="text-center">
                  <div class="h-1.5 rounded-full ${idx <= stepIdx ? 'bg-gradient-to-r from-amber-400 to-emerald-400' : 'bg-slate-800'}"></div>
                  <div class="text-[9px] mt-0.5 ${idx === stepIdx ? 'text-amber-300 font-extrabold' : (idx < stepIdx ? 'text-emerald-400' : 'text-slate-500')}">${idx + 1}. ${st}</div>
                </div>
              `).join('')}
            </div>
          ` : ''}

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

          <div class="pt-2 border-t border-slate-800 flex flex-wrap gap-1.5 justify-end">
            ${s.statusPengerjaan === 'Diterima' ? `
              <button onclick="window.AZI.quickAdvanceService('${escJs(s.no)}', 'Dikerjakan')" class="px-3 py-1.5 rounded-xl bg-sky-600/30 hover:bg-sky-600/45 border border-sky-400/50 text-sky-200 font-bold text-[11px]">▶ Mulai Kerjakan</button>
            ` : ''}
            ${s.statusPengerjaan === 'Dikerjakan' ? `
              <button onclick="window.AZI.openServiceWorkModal('${escJs(s.no)}', 'Selesai')" class="px-3 py-1.5 rounded-xl bg-emerald-600/30 hover:bg-emerald-600/45 border border-emerald-400/50 text-emerald-200 font-bold text-[11px]">✅ Selesaikan & Isi Jasa</button>
            ` : ''}
            ${s.statusPengerjaan === 'Selesai' ? `
              <button onclick="window.AZI.quickHandoverService('${escJs(s.no)}')" class="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[11px]">🤝 Serahkan Unit (Diambil)</button>
            ` : ''}
            <button onclick="window.AZI.openServiceWorkModal('${escJs(s.no)}')" class="px-3 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 font-bold text-[11px]">
              Edit Part & Jasa
            </button>
            ${(!isBatal && s.sisaTagihan > 0) ? `
              <button onclick="window.AZI.openPayModal('SERVIS', '${escJs(s.no)}', ${s.sisaTagihan})" class="px-3 py-1.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 font-bold text-[11px]">
                💳 Lunasi
              </button>
            ` : ''}
            <button onclick="window.AZI.openReceiptModal('SERVIS_TERIMA', '${escJs(s.no)}')" class="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-[11px]">
              Tanda Terima
            </button>
            ${(s.statusPengerjaan === 'Selesai' || s.statusPengerjaan === 'Diambil') ? `
              <button onclick="window.AZI.openReceiptModal('SERVIS_FINAL', '${escJs(s.no)}')" class="px-3 py-1.5 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/40 text-sky-300 font-bold text-[11px]">
                🧾 Nota / Print 2x
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  function renderServisView() {
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
            <h3 class="text-sm font-extrabold text-white">Daftar Pengerjaan Servis</h3>
            <input id="servis-search" type="text" value="${esc(servisSearchQuery)}" oninput="window.AZI.filterServisList(this.value)" placeholder="🔍 Cari No. Servis (SRV-) / Pelanggan / HP..." class="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white w-full sm:w-64" />
          </div>
          <div id="servis-cards-list" class="space-y-3 max-h-[600px] overflow-y-auto pr-1">
            ${renderServisCardsList(servisSearchQuery)}
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
              <button onclick="window.AZI.editMasterBarang('${escJs(b.sku)}')" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 font-bold text-[10px]">Edit</button>
              <button onclick="window.AZI.toggleBarangActive('${escJs(b.sku)}')" class="px-2 py-1 rounded ${b.aktif ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'} font-bold text-[10px]">${b.aktif ? 'Aktif' : 'Nonaktif'}</button>
            </td>
          ` : ''}
        </tr>
      `;
    }).join('');
  }

  function renderMutasiRows(queryText) {
    const q = String(queryText || '').trim().toLowerCase();
    const list = db.riwayatStok.filter((m) => {
      if (!q) return true;
      return (
        String(m.sku || '').toLowerCase().includes(q) ||
        String(m.nama || '').toLowerCase().includes(q) ||
        String(m.ref || '').toLowerCase().includes(q) ||
        String(m.jenis || '').toLowerCase().includes(q) ||
        String(m.petugas || '').toLowerCase().includes(q)
      );
    });
    if (list.length === 0) {
      return `<tr><td colspan="6" class="py-5 text-center text-slate-500">Tidak ada mutasi stok yang cocok.</td></tr>`;
    }
    return list.map((m) => `
      <tr>
        <td class="py-2 text-slate-400">${esc(m.waktu)}</td>
        <td class="py-2 font-semibold text-white">${esc(m.nama)} <span class="text-[10px] font-mono-num text-sky-400">(${esc(m.sku)})</span></td>
        <td class="py-2 text-sky-300">${esc(m.jenis)} (${esc(m.ref)})</td>
        <td class="py-2 text-center font-mono-num font-bold ${m.masuk > 0 ? 'text-emerald-400' : 'text-rose-400'}">${m.masuk > 0 ? '+' + m.masuk : '-' + m.keluar}</td>
        <td class="py-2 text-center font-mono-num">${m.sesudah}</td>
        <td class="py-2 text-slate-300">${esc(m.petugas)}</td>
      </tr>
    `).join('');
  }

  function renderStokView() {
    const akses = currentUser.akses;
    const canManage = canManageStock();
    const firstAdj = db.barang[0];
    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        ${canManage ? `
          <!-- TAMBAH BARANG / PENYESUAIAN STOK (KHUSUS PEMILIK / GUDANG) -->
          <div class="lg:col-span-4 space-y-5">
            <div class="glass-card rounded-2xl p-5 space-y-3">
              <div class="flex items-center justify-between border-b border-slate-800 pb-2">
                <h3 class="text-sm font-extrabold text-white">Tambah / Edit Master Barang</h3>
                <button type="button" onclick="window.AZI.resetMasterBarangForm()" class="text-[10px] text-sky-400 hover:underline font-bold">Reset Form</button>
              </div>
              <div id="brg-edit-banner" class="${editingBarangSku ? '' : 'hidden '}p-2 rounded-xl bg-amber-950/60 border border-amber-500/40 text-[11px] text-amber-200 flex items-center justify-between gap-2">
                <span>📝 Mode Edit: <b class="font-mono-num">${esc(editingBarangSku)}</b></span>
                <button type="button" onclick="window.AZI.resetMasterBarangForm()" class="text-[10px] text-rose-300 font-bold underline">Batal</button>
              </div>
              <form id="form-master-barang" onsubmit="window.AZI.submitMasterBarang(event)" class="space-y-2.5 text-xs">
                <div class="relative">
                  <div class="grid grid-cols-2 gap-2">
                    <input id="brg-sku" type="text" required oninput="window.AZI.handleMasterSkuSuggest(this.value)" placeholder="Kode SKU Unik *" autocomplete="off" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
                    <input id="brg-barcode" type="text" oninput="window.AZI.handleMasterSkuSuggest(this.value)" placeholder="Barcode (Opsional)" autocomplete="off" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
                  </div>
                  <div id="brg-sku-suggest" class="hidden mt-1 p-2 rounded-xl bg-slate-950 border border-amber-500/40 space-y-1 max-h-36 overflow-y-auto"></div>
                </div>
                <input id="brg-nama" type="text" required placeholder="Nama Lengkap Barang *" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
                <div class="grid grid-cols-2 gap-2">
                  <input id="brg-kategori" type="text" required placeholder="Kategori (Aksesoris/Part)" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
                  <input id="brg-satuan" type="text" required placeholder="Satuan (pcs/unit)" value="pcs" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <div>
                    <label class="block text-[10px] text-slate-400 mb-1">Harga Modal (Rp)</label>
                    <input id="brg-modal" type="number" min="0" required value="0" oninput="window.AZI.checkMasterPriceMargin()" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
                  </div>
                  <div>
                    <label class="block text-[10px] text-slate-400 mb-1">Harga Jual (Rp)</label>
                    <input id="brg-jual" type="number" min="0" required value="0" oninput="window.AZI.checkMasterPriceMargin()" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-amber-300 font-mono-num" />
                  </div>
                </div>
                <div id="brg-margin-warn" class="hidden p-2 rounded-lg text-[11px] font-semibold"></div>
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
                <select id="adj-sku" onchange="window.AZI.recalcStockAdjPreview()" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                  ${db.barang.length ? db.barang.map((b) => `<option value="${esc(b.sku)}">${esc(b.sku)} — ${esc(b.nama)} (Sisa: ${getStokAkhir(b)})</option>`).join('') : `<option value="">-- Belum ada Master Barang (Tambah di form atas) --</option>`}
                </select>
                <div class="grid grid-cols-2 gap-2">
                  <select id="adj-jenis" onchange="window.AZI.recalcStockAdjPreview()" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                    <option value="KELUAR">Koreksi Keluar / Rusak</option>
                    <option value="MASUK">Koreksi Masuk / Opname+</option>
                  </select>
                  <input id="adj-qty" type="number" min="1" required placeholder="Jumlah Unit" oninput="window.AZI.recalcStockAdjPreview()" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white font-mono-num" />
                </div>
                <div id="adj-preview" class="p-2 rounded-lg bg-slate-900/90 border border-slate-800 text-[11px] text-slate-300 font-mono-num">
                  ${firstAdj ? `Stok saat ini: ${getStokAkhir(firstAdj)} ${esc(firstAdj.satuan)}` : 'Belum ada barang.'}
                </div>
                <input id="adj-alasan" type="text" required placeholder="Alasan wajib (mis: Barang rusak / Stok Opname)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
                <button type="submit" class="w-full py-2.5 rounded-xl btn-cyber text-xs">Catat Penyesuaian Stok</button>
              </form>
            </div>
          </div>
        ` : ''}

        <!-- TABEL STOK BARANG & KARTU RIWAYAT GERAKAN -->
        <div class="${canManage ? 'lg:col-span-8' : 'lg:col-span-12'} space-y-5">
          <div class="glass-card rounded-2xl p-5">
            <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h3 class="text-sm font-extrabold text-white">Daftar Persediaan (Stok Akhir = Awal + Masuk - Keluar)</h3>
              <input id="stok-search" type="text" value="${esc(stokSearchQuery)}" oninput="window.AZI.filterStokTable(this.value)" placeholder="🔍 Cari SKU / Nama / Barcode..." class="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white w-full sm:w-56" />
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
                    ${canManage ? `<th class="py-2 text-right">Aksi</th>` : ''}
                  </tr>
                </thead>
                <tbody id="stok-table-body" class="divide-y divide-slate-800/60">
                  ${renderStokTableRows(stokSearchQuery)}
                </tbody>
              </table>
            </div>
          </div>

          <div class="glass-card rounded-2xl p-5">
            <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h3 class="text-sm font-extrabold text-white">Kartu Riwayat Mutasi Stok & Petugas</h3>
              <input id="mutasi-search" type="text" value="${esc(mutasiSearchQuery)}" oninput="window.AZI.filterMutasiTable(this.value)" placeholder="🔍 Cari SKU / No. PJ-SRV-PB / Petugas..." class="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white w-full sm:w-64" />
            </div>
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
                <tbody id="mutasi-table-body" class="divide-y divide-slate-800/60">
                  ${renderMutasiRows(mutasiSearchQuery)}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // BAB 06.B: PEMBELIAN & BARANG MASUK PEMASOK (AUTO-SEARCH + CETAK NOTA 2X)
  // ==========================================================================
  function renderPembelianHistoryRows(queryText) {
    const q = String(queryText || '').trim().toLowerCase();
    const filteredPb = db.pembelian.filter((pb) => {
      if (!isInDateFilter(pb.tanggal)) return false;
      if (!q) return true;
      const itemTxt = (pb.items || []).map((i) => `${i.sku} ${i.nama}`).join(' ').toLowerCase();
      return (
        String(pb.no || '').toLowerCase().includes(q) ||
        String(pb.refNota || '').toLowerCase().includes(q) ||
        String(pb.pemasok || '').toLowerCase().includes(q) ||
        String(pb.statusBayar || '').toLowerCase().includes(q) ||
        itemTxt.includes(q)
      );
    });
    if (filteredPb.length === 0) {
      return `<tr><td colspan="8" class="py-6 text-center text-slate-500">Tidak ada nota pembelian yang cocok.</td></tr>`;
    }
    return filteredPb.map((pb) => `
      <tr>
        <td class="py-2.5 font-mono-num font-bold text-amber-300">
          <div>${esc(pb.no)}</div>
          <div class="text-[10px] text-slate-400">Ref: ${esc(pb.refNota || '-')}</div>
        </td>
        <td class="py-2.5 text-slate-300">${esc(pb.tanggal)}</td>
        <td class="py-2.5">
          <div class="font-semibold text-white">${esc(pb.pemasok)}</div>
          <div class="text-[10px] text-slate-400">${esc((pb.items || []).map((i) => `${i.nama} (${i.qty} ${i.satuan || ''})`).join(', '))}</div>
        </td>
        <td class="py-2.5 font-mono-num text-white">${rp(pb.total)}</td>
        <td class="py-2.5 font-mono-num text-emerald-300">${rp(pb.dibayar)}</td>
        <td class="py-2.5 font-mono-num text-rose-300 font-bold">${rp(pb.sisaUtang)}</td>
        <td class="py-2.5"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${pb.statusBayar === 'Lunas' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">${esc(pb.statusBayar)}</span></td>
        <td class="py-2.5 text-right whitespace-nowrap">
          <button onclick="window.AZI.openReceiptModal('PEMBELIAN', '${escJs(pb.no)}')" class="px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/40 text-sky-300 font-bold text-[11px]">🧾 Cek / Print 2x</button>
        </td>
      </tr>
    `).join('');
  }

  function renderPembelianView() {
    const selectedItem = db.barang.find((b) => b.sku === pbSelectedSku) || db.barang[0] || { sku: '', nama: '', satuan: 'pcs', hargaModal: 0, pemasok: '' };
    pbSelectedSku = selectedItem.sku || '';
    const defaultQty = 1;
    const defaultHarga = Number(selectedItem.hargaModal) || 0;
    const defaultTotal = defaultQty * defaultHarga;
    const stokSaatIni = selectedItem.sku ? getStokAkhir(selectedItem) : 0;

    return `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div class="lg:col-span-5 glass-card rounded-2xl p-5 space-y-3">
          <h3 class="text-sm font-extrabold text-white border-b border-slate-800 pb-2">Catat Barang Masuk / Pembelian Pemasok</h3>
          <form onsubmit="window.AZI.submitPembelian(event)" class="space-y-3 text-xs">
            <div class="relative">
              <label class="block text-[10px] text-sky-300 font-bold mb-1">🔍 Cari Cepat Kode SKU / Barcode / Nama Barang</label>
              <input id="pb-item-search" type="text" value="${esc(pbItemSearchQuery)}" oninput="window.AZI.handlePembelianItemSearch(this.value)" onfocus="window.AZI.handlePembelianItemSearch(this.value)" placeholder="Ketik SKU (mis: LCD, KBL) atau Barcode..." autocomplete="off" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-sky-500/40 text-white" />
              <div id="pb-item-suggest" class="hidden absolute left-0 right-0 top-full mt-1 z-30 glass-card rounded-xl border border-amber-500/40 p-1.5 max-h-48 overflow-y-auto space-y-1 shadow-2xl"></div>
            </div>
            <div>
              <label class="block text-[10px] text-slate-400 mb-1">Barang Terpilih</label>
              <select id="pb-sku" onchange="window.AZI.onPembelianItemChange(this.value)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                ${db.barang.length ? db.barang.map((b) => `<option value="${esc(b.sku)}" ${b.sku === pbSelectedSku ? 'selected' : ''}>${esc(b.sku)} — ${esc(b.nama)} (Stok: ${getStokAkhir(b)} | Modal: ${rp(b.hargaModal)})</option>`).join('') : `<option value="">-- Belum ada Master Barang (Tambah di menu Barang & Stok) --</option>`}
              </select>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <input id="pb-pemasok" type="text" required value="${esc(selectedItem.pemasok && selectedItem.pemasok !== '-' ? selectedItem.pemasok : '')}" placeholder="Nama Pemasok / Supplier *" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
              <input id="pb-ref" type="text" required placeholder="No. Nota Pemasok *" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
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
            <div class="p-3 rounded-xl bg-slate-900/90 border border-slate-800 space-y-1">
              <div class="flex items-center justify-between">
                <span class="text-slate-400">Total Pembelian:</span>
                <span id="pb-total-preview" class="text-sm font-extrabold font-mono-num text-amber-300">${rp(defaultTotal)}</span>
              </div>
              <div id="pb-stock-preview" class="text-[11px] text-sky-300 font-mono-num">
                Pratinjau Stok: ${stokSaatIni} &rarr; ${stokSaatIni + defaultQty} ${esc(selectedItem.satuan || 'pcs')} | Modal Baru: ${rp(defaultHarga)}
              </div>
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
            <button type="submit" class="w-full py-3 rounded-xl btn-luxury text-xs uppercase">Simpan Barang Masuk & Cek Nota</button>
          </form>
        </div>

        <div class="lg:col-span-7 glass-card rounded-2xl p-5">
          <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 class="text-sm font-extrabold text-white">Riwayat Pembelian & Cek Nota Keluar</h3>
            <input id="pb-history-search" type="text" value="${esc(pembelianSearchQuery)}" oninput="window.AZI.filterPembelianHistory(this.value)" placeholder="🔍 Cari No. Beli (PB-) / Nota / Pemasok / Barang..." class="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white w-full sm:w-64" />
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
                  <th class="py-2 text-right">Cek / Cetak</th>
                </tr>
              </thead>
              <tbody id="pb-history-tbody" class="divide-y divide-slate-800/60">
                ${renderPembelianHistoryRows(pembelianSearchQuery)}
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
  function renderPembayaranSectionsHtml(queryText) {
    const q = String(queryText || '').trim().toLowerCase();
    const matchStr = (...vals) => !q || vals.some((v) => String(v || '').toLowerCase().includes(q));
    const piutangSales = db.penjualan.filter((p) => p.statusDokumen === 'Final' && p.sisaPiutang > 0 && matchStr(p.no, p.pelanggan, p.kontak));
    const piutangServis = db.servis.filter((s) => s.statusPengerjaan !== 'Batal' && s.sisaTagihan > 0 && matchStr(s.no, s.pelanggan, s.kontak, s.merekModel));
    const utangBeli = db.pembelian.filter((pb) => pb.sisaUtang > 0 && matchStr(pb.no, pb.refNota, pb.pemasok));
    const historyPay = db.pembayaranTagihan.filter((p) => isInDateFilter(p.tanggalJam) && matchStr(p.noRef, p.pihak, p.jenis, p.metode, p.refTransfer));

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
                <button onclick="window.AZI.openPayModal('SERVIS', '${escJs(s.no)}', ${s.sisaTagihan})" class="px-3 py-2 rounded-xl btn-luxury text-xs shrink-0">Terima Pelunasan</button>
              </div>
            `).join('')}
            ${piutangSales.map((p) => `
              <div class="p-3.5 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between gap-2 text-xs">
                <div>
                  <div class="font-bold text-sky-300">${esc(p.no)} (Penjualan — ${esc(p.pelanggan)})</div>
                  <div class="text-slate-400">Total: ${rp(p.totalAkhir)} | Sudah Bayar: ${rp(p.jumlahTerbayar)}</div>
                  <div class="font-bold text-rose-400 font-mono-num">Sisa Piutang: ${rp(p.sisaPiutang)}</div>
                </div>
                <button onclick="window.AZI.openPayModal('PENJUALAN', '${escJs(p.no)}', ${p.sisaPiutang})" class="px-3 py-2 rounded-xl btn-luxury text-xs shrink-0">Terima Pelunasan</button>
              </div>
            `).join('')}
            ${piutangServis.length === 0 && piutangSales.length === 0 ? `<p class="text-xs text-emerald-400 py-4 text-center">${q ? 'Tidak ada tagihan yang cocok.' : 'Semua tagihan pelanggan sudah Lunas!'}</p>` : ''}
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
                <button onclick="window.AZI.openPayModal('PEMBELIAN', '${escJs(pb.no)}', ${pb.sisaUtang})" class="px-3 py-2 rounded-xl btn-cyber text-xs shrink-0">Bayar Utang</button>
              </div>
            `).join('')}
            ${utangBeli.length === 0 ? `<p class="text-xs text-emerald-400 py-4 text-center">${q ? 'Tidak ada utang yang cocok.' : 'Tidak ada utang pemasok yang belum lunas.'}</p>` : ''}
          </div>
        </div>
      </div>

      <!-- RIWAYAT PEMBAYARAN TAGIHAN -->
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

  function renderPembayaranView() {
    return `
      <div class="glass-panel rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 class="text-sm font-extrabold text-white">Cari Cepat Tagihan & Riwayat Pelunasan</h3>
          <p class="text-[11px] text-slate-400">Ketik No. Transaksi (PJ-), No. Servis (SRV-), No. Beli (PB-), atau nama pelanggan/pemasok.</p>
        </div>
        <input id="pay-search" type="text" value="${esc(pembayaranSearchQuery)}" oninput="window.AZI.filterPembayaranView(this.value)" placeholder="🔍 Cari No. Ref / Pelanggan / Pemasok..." class="px-3.5 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white w-full sm:w-72" />
      </div>
      <div id="pembayaran-content-wrap" class="space-y-6">
        ${renderPembayaranSectionsHtml(pembayaranSearchQuery)}
      </div>
    `;
  }

  // ==========================================================================
  // BAB 12: KAS, MODAL PEMILIK, BIAYA OPERASIONAL & TRANSFER ANTAR AKUN
  // ==========================================================================
  function renderKasHistoryRows(queryText) {
    const q = String(queryText || '').trim().toLowerCase();
    const filteredKas = db.kasModal.filter((k) => {
      if (!isInDateFilter(k.tanggalJam)) return false;
      if (!q) return true;
      return (
        String(k.noRef || '').toLowerCase().includes(q) ||
        String(k.kategori || '').toLowerCase().includes(q) ||
        String(k.keterangan || '').toLowerCase().includes(q) ||
        String(k.petugas || '').toLowerCase().includes(q) ||
        String(k.jenis || '').toLowerCase().includes(q)
      );
    });
    if (filteredKas.length === 0) {
      return `<tr><td colspan="4" class="py-6 text-center text-slate-500">Tidak ada mutasi kas yang cocok.</td></tr>`;
    }
    return filteredKas.map((k) => `
      <tr>
        <td class="py-2 text-slate-400">${esc(k.tanggalJam)}</td>
        <td class="py-2">
          <div class="font-semibold text-white">${esc(k.kategori)}</div>
          ${k.noRef && k.noRef !== 'MANUAL' ? `<div class="text-[10px] font-mono-num text-amber-300">Ref: ${esc(k.noRef)}</div>` : ''}
        </td>
        <td class="py-2 text-slate-300">${esc(k.keterangan)}</td>
        <td class="py-2 text-right font-mono-num font-bold ${k.jenis === 'Masuk' ? 'text-emerald-400' : k.jenis === 'Keluar' ? 'text-rose-400' : 'text-sky-400'}">${k.jenis === 'Keluar' ? '-' : (k.jenis === 'Transfer' ? '⇄ ' : '+')}${rp(k.nominal)}</td>
      </tr>
    `).join('');
  }

  function renderKasModalView() {
    const balances = getAccountBalances();
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
            <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h3 class="text-sm font-extrabold text-white">Buku Arus Kas & Modal</h3>
              <input id="kas-search" type="text" value="${esc(kasSearchQuery)}" oninput="window.AZI.filterKasHistory(this.value)" placeholder="🔍 Cari Ref (PJ/SRV/PB) / Kategori / Ket..." class="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white w-full sm:w-64" />
            </div>
            <div class="overflow-x-auto max-h-80">
              <table class="w-full text-left text-xs">
                <thead>
                  <tr class="border-b border-slate-800 text-slate-400">
                    <th class="py-2">Waktu</th>
                    <th class="py-2">Kategori & Ref</th>
                    <th class="py-2">Keterangan</th>
                    <th class="py-2 text-right">Nominal</th>
                  </tr>
                </thead>
                <tbody id="kas-history-tbody" class="divide-y divide-slate-800/60">
                  ${renderKasHistoryRows(kasSearchQuery)}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // BAB 13: RETUR PENJUALAN, RETUR PEMBELIAN & KOREKSI (AUTO-SEARCH TRANSAKSI)
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
              <select id="ret-jenis" onchange="window.AZI.handleReturRefSearch(document.getElementById('ret-noref').value)" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                <option value="Retur Penjualan">Retur Penjualan Pelanggan</option>
                <option value="Retur Pembelian">Retur Pembelian ke Pemasok</option>
              </select>
              <div class="relative">
                <label class="block text-[10px] text-sky-300 font-bold mb-1">🔍 Ketik No. Transaksi Asal (Otomatis Muncul & Isi Barang)</label>
                <input id="ret-noref" type="text" required oninput="window.AZI.handleReturRefSearch(this.value)" onfocus="window.AZI.handleReturRefSearch(this.value)" placeholder="Ketik PJ- / PB- / Nama Pelanggan / Pemasok *" autocomplete="off" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-sky-500/40 text-white font-mono-num" />
                <div id="ret-ref-suggest" class="hidden absolute left-0 right-0 top-full mt-1 z-30 glass-card rounded-xl border border-amber-500/40 p-1.5 max-h-48 overflow-y-auto space-y-1 shadow-2xl"></div>
                <div id="ret-ref-badge" class="mt-1 text-[10px] text-slate-400">Ketik nomor transaksi untuk memilih otomatis tanpa salah ketik.</div>
              </div>
              <select id="ret-sku" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white">
                ${db.barang.length ? db.barang.map((b) => `<option value="${esc(b.sku)}">${esc(b.sku)} — ${esc(b.nama)} (Stok: ${getStokAkhir(b)})</option>`).join('') : `<option value="">-- Belum ada Master Barang --</option>`}
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
              <div class="flex flex-wrap items-center gap-2">
                <button onclick="window.AZI.exportReportExcel()" class="px-4 py-2.5 rounded-xl btn-luxury text-xs flex items-center gap-1.5">
                  <span>📊</span><span>Unduh Excel Rapi (.xls — 5 Sheet)</span>
                </button>
                <button onclick="window.AZI.exportReportCsv('lengkap')" class="px-3.5 py-2.5 rounded-xl btn-cyber text-xs flex items-center gap-1.5">
                  <span>📥</span><span>CSV Ringkasan Rapi</span>
                </button>
              </div>
            ` : ''}
          </div>

          ${akses.ekspor_laporan ? `
            <div class="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div class="text-slate-300">
                <span class="font-bold text-emerald-400">Ekspor CSV Bersih Per Tabel</span>
                <span class="text-[11px] text-slate-400 ml-1">(Sudah otomatis rapi dibuka di Excel Indonesia tanpa edit kolom):</span>
              </div>
              <div class="flex flex-wrap gap-1.5">
                <button onclick="window.AZI.exportReportCsv('penjualan')" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-sky-500/30 text-sky-300 font-bold text-[11px]">📥 CSV Penjualan</button>
                <button onclick="window.AZI.exportReportCsv('servis')" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-amber-500/30 text-amber-300 font-bold text-[11px]">📥 CSV Servis</button>
                <button onclick="window.AZI.exportReportCsv('stok')" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-emerald-500/30 text-emerald-300 font-bold text-[11px]">📥 CSV Stok Barang</button>
                <button onclick="window.AZI.exportReportCsv('kas')" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-indigo-500/30 text-indigo-300 font-bold text-[11px]">📥 CSV Arus Kas</button>
              </div>
            </div>
          ` : ''}

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
              <input id="usr-pass" type="password" autocomplete="new-password" placeholder="Password Baru (Kosongkan jk edit)" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-amber-300 font-mono-num" />
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
                  <button onclick="window.AZI.editKaryawan('${escJs(u.username)}')" class="px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 font-bold text-[11px]">Edit</button>
                  <button onclick="window.AZI.resetUserPassword('${escJs(u.username)}')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 font-bold text-[11px]">Reset Sandi</button>
                  <button onclick="window.AZI.toggleUserActive('${escJs(u.username)}')" class="px-2.5 py-1 rounded-lg ${u.aktif ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'} font-bold text-[11px]">
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
              ${currentUser.jabatan === 'Pemilik' ? `
                <button type="button" onclick="window.AZI.confirmResetCleanProduction()" class="px-3.5 py-2 rounded-xl bg-rose-950/80 hover:bg-rose-900 border border-rose-500/50 text-rose-200 font-bold">🧹 Reset Data & Dummy (Mulai Nol)</button>
              ` : ''}
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
                  <button type="button" onclick="window.AZI.editAkunKas('${escJs(a.id)}')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 font-bold text-[10px]">Edit</button>
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
    if (!currentUser || !currentUser.akses) return;
    const mns = currentUser.akses.menus || [];
    if (docType === 'PEMBELIAN' && !mns.includes('pembelian') && !currentUser.akses.lihat_modal) {
      showToast('Akses ditolak untuk melihat nota pembelian pemasok!', 'error');
      return;
    }
    if (docType === 'PENJUALAN' && !mns.includes('penjualan') && !mns.includes('pembayaran') && !mns.includes('retur') && !mns.includes('laporan')) {
      showToast('Akses ditolak untuk melihat nota penjualan!', 'error');
      return;
    }
    if ((docType === 'SERVIS_TERIMA' || docType === 'SERVIS_FINAL') && !mns.includes('servis') && !mns.includes('pembayaran') && !mns.includes('retur') && !mns.includes('laporan')) {
      showToast('Akses ditolak untuk melihat nota servis!', 'error');
      return;
    }
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
    } else if (docType === 'PEMBELIAN') {
      const pb = db.pembelian.find((x) => x.no === refNo);
      if (!pb) return;
      const items = Array.isArray(pb.items) ? pb.items : [];
      title = pb.statusBayar === 'Lunas' ? 'NOTA PEMBELIAN STOK (LUNAS)' : 'BUKTI PEMBELIAN STOK (UTANG)';
      pelanggan = `Pemasok: ${pb.pemasok}`;
      tanggal = pb.tanggal;
      petugas = pb.petugas || '-';
      statusBayar = pb.statusBayar;
      extraMetaHtml = `<div>Ref Nota Pemasok: <b>${esc(pb.refNota || '-')}</b></div>`;
      itemsHtml = `
        <div class="font-bold underline mb-1">Rincian Barang Masuk:</div>
        ${items.map((i) => `
          <div class="py-0.5">
            <div class="font-semibold">${esc(i.nama)} (${esc(i.sku)})</div>
            <div class="flex justify-between pl-2">
              <span>${i.qty} ${esc(i.satuan || 'pcs')} x ${rp(i.hargaBeli)}</span>
              <span>${rp(i.qty * i.hargaBeli)}</span>
            </div>
          </div>
        `).join('')}
      `;
      summaryHtml = `
        <div class="flex justify-between font-bold text-sm"><span>TOTAL PEMBELIAN:</span><span>${rp(pb.total)}</span></div>
        <div class="flex justify-between"><span>Sudah Dibayar:</span><span>${rp(pb.dibayar)}</span></div>
        <div class="flex justify-between font-bold"><span>Sisa Utang:</span><span>${rp(pb.sisaUtang)}</span></div>
      `;
      blePayload = buildEscPosReceipt({
        title,
        metaLines: [
          `No Beli  : ${pb.no}`,
          `Ref Nota : ${pb.refNota || '-'}`,
          `Tanggal  : ${pb.tanggal}`,
          `Petugas  : ${petugas}`,
          `Pemasok  : ${pb.pemasok}`
        ],
        sections: [{
          heading: 'RINCIAN BARANG MASUK:',
          lines: items.map((i) => ({
            name: `${i.nama} (${i.sku})`,
            detailLeft: `${i.qty} x ${rp(i.hargaBeli)}`,
            detailRight: rp(i.qty * i.hargaBeli)
          }))
        }],
        summaryRows: [
          { left: 'TOTAL PEMBELIAN', right: rp(pb.total), bold: true },
          { left: 'Sudah Dibayar', right: rp(pb.dibayar) },
          { left: 'Sisa Utang', right: rp(pb.sisaUtang), bold: true }
        ],
        statusBayar: pb.statusBayar
      });
      waPhone = '';
      waText = `*${db.config.namaToko}*\n${title}\nNo Beli: ${pb.no} | Ref: ${pb.refNota || '-'}\nTanggal: ${pb.tanggal}\nPemasok: ${pb.pemasok}\n\n*Rincian Barang Masuk:*\n` +
        items.map((i) => `• ${i.nama} (${i.qty}x ${rp(i.hargaBeli)}) = ${rp(i.qty * i.hargaBeli)}`).join('\n') +
        `\n\n*TOTAL: ${rp(pb.total)}*\nDibayar: ${rp(pb.dibayar)}\nSisa Utang: ${rp(pb.sisaUtang)}\nStatus: *${pb.statusBayar.toUpperCase()}*`;
    }

    const bleWidth = db.config.lebarPrinter === '80mm' ? 48 : 32;
    const cutSep = '\n' + '- '.repeat(Math.floor(bleWidth / 2)) + '\n';
    const copy2Header = '\x1B\x61\x01\x1B\x45\x01[ SALINAN KE-2 / ARSIP TOKO ]\n\x1B\x45\x00\x1B\x61\x00';
    lastReceiptBlePayload = blePayload;
    lastReceiptBleCopy2 = blePayload + cutSep + copy2Header + blePayload;
    lastReceiptMeta = { docType, refNo };

    const cleanWaDigits = String(waPhone || '').replace(/\D/g, '').replace(/^0/, '62');
    const waShareUrl = `https://wa.me/${cleanWaDigits}?text=${encodeURIComponent(waText)}`;
    const paperClass = db.config.lebarPrinter === '80mm' ? 'receipt-80mm' : 'receipt-58mm';
    const isBtConn = bluetoothStatus === 'connected' && Boolean(bluetoothCharacteristic);

    const buildReceiptBlockHtml = (copyLabel) => `
      <div>
        <div class="text-center border-b border-dashed border-black pb-2 mb-2">
          <div class="font-extrabold text-sm">${esc(db.config.namaToko)}</div>
          <div>${esc(db.config.alamat)}</div>
          <div>Telp/WA: ${esc(db.config.kontak)}</div>
          <div class="font-bold mt-1">${esc(title)}</div>
          <div class="text-[10px] font-bold tracking-wider mt-0.5">${copyLabel}</div>
        </div>
        <div class="border-b border-dashed border-black pb-2 mb-2">
          <div>No: <b>${esc(refNo)}</b></div>
          <div>Waktu: ${esc(tanggal)}</div>
          <div>Petugas: ${esc(petugas)}</div>
          <div>${docType === 'PEMBELIAN' ? '' : 'Pelanggan: '}${esc(pelanggan)}</div>
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
    `;

    openModal(`
      <div class="glass-card rounded-2xl p-5 sm:p-6 max-w-lg w-full space-y-4 my-4">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h3 class="text-sm font-extrabold text-white">Cek & Cetak Nota (${esc(db.config.lebarPrinter)})</h3>
            <p class="text-[10px] ${isBtConn ? 'text-emerald-400' : 'text-rose-400'}">
              Bluetooth: ${isBtConn ? `Terhubung (${esc(bluetoothDeviceName || 'Thermal')})` : 'Belum Konek (Merah)'} • Mendukung Cetak 1x & 2x (Asli + Arsip Toko)
            </p>
          </div>
          <button onclick="window.AZI.closeModal()" class="text-slate-400 hover:text-white text-xl">&times;</button>
        </div>

        <!-- AREA KERTAS STRUK THERMAL (DUKUNG PRINT 1X & PRINT 2X ASLI + SALINAN TOKO) -->
        <div class="flex justify-center bg-slate-950 p-4 rounded-xl overflow-x-auto max-h-[52vh] overflow-y-auto">
          <div id="thermal-print-area" class="${paperClass} bg-white text-black p-4 rounded shadow-xl">
            ${buildReceiptBlockHtml('[ ASLI — UNTUK PELANGGAN / PIHAK TERKAIT ]')}
            <div class="copy-print-only">
              <div class="receipt-cut-line">✂ - - - - - POTONG DI SINI - - - - - ✂</div>
              ${buildReceiptBlockHtml('[ SALINAN KE-2 — ARSIP TOKO ]')}
            </div>
          </div>
        </div>

        <!-- TOMBOL CETAK 1X, CETAK 2X (BLUETOOTH & PDF/SISTEM), & KIRIM WA -->
        <div class="space-y-2">
          <div class="grid grid-cols-2 gap-2">
            <button id="modal-ble-print-btn" onclick="window.AZI.printCurrentReceiptBluetooth(1)" class="py-2.5 px-3 rounded-xl ${isBtConn ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-rose-600/80 hover:bg-rose-600'} text-white font-bold text-xs flex items-center justify-center gap-1.5">
              <span>🖨️</span><span>${isBtConn ? 'Cetak 1x Bluetooth' : 'Konek & Cetak 1x BT'}</span>
            </button>
            <button onclick="window.AZI.printCurrentReceiptBluetooth(2)" class="py-2.5 px-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs flex items-center justify-center gap-1.5">
              <span>🖨️</span><span>Cetak 2x Bluetooth</span>
            </button>
          </div>
          <div class="grid grid-cols-3 gap-2">
            <button onclick="window.AZI.printSystemReceipt(1)" class="py-2.5 px-2.5 rounded-xl btn-luxury text-xs">
              📄 Print 1x
            </button>
            <button onclick="window.AZI.printSystemReceipt(2)" class="py-2.5 px-2.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-amber-200 font-extrabold text-xs">
              📄 Print 2x (Asli+Arsip)
            </button>
            <a href="${esc(waShareUrl)}" target="_blank" rel="noopener noreferrer" class="py-2.5 px-2.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 font-bold text-xs text-center flex items-center justify-center gap-1">
              <span>📲</span><span>Kirim WA</span>
            </a>
          </div>
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

    // ========================================================================
    // PENCARIAN CEPAT GLOBAL (AUTO-SEARCH DI SEMUA MENU + ANTI HUMAN ERROR)
    // ========================================================================
    handleGlobalSearch(query) {
      globalSearchQuery = String(query || '');
      const clearBtn = document.getElementById('global-search-clear');
      const box = document.getElementById('global-search-dropdown');
      if (clearBtn) clearBtn.classList.toggle('hidden', globalSearchQuery.trim() === '');
      if (!box) return;

      const q = globalSearchQuery.trim().toLowerCase();
      if (!q) {
        box.classList.add('hidden');
        box.innerHTML = '';
        return;
      }

      const akses = currentUser.akses;
      const sections = [];

      // 1. Cari Penjualan (PJ-...)
      if (akses.menus.includes('penjualan')) {
        const salesHits = db.penjualan.filter((p) => {
          if (!akses.semua_transaksi && p.petugas !== currentUser.username) return false;
          const itemsStr = (p.items || []).map((i) => `${i.sku} ${i.nama}`).join(' ').toLowerCase();
          return String(p.no).toLowerCase().includes(q) || String(p.pelanggan).toLowerCase().includes(q) || String(p.kontak).toLowerCase().includes(q) || itemsStr.includes(q);
        }).slice(0, 5);
        if (salesHits.length) {
          sections.push(`
            <div>
              <div class="text-[10px] font-extrabold uppercase tracking-wider text-sky-400 px-2 py-1">🛒 Penjualan (${salesHits.length})</div>
              ${salesHits.map((p) => `
                <div class="p-2 rounded-xl hover:bg-slate-800/80 flex items-center justify-between gap-2 text-xs">
                  <div class="min-w-0">
                    <span class="font-mono-num font-bold text-amber-300">${esc(p.no)}</span>
                    <span class="text-white font-semibold ml-1.5">${esc(p.pelanggan)}</span>
                    <span class="text-slate-400 ml-1.5 font-mono-num">${rp(p.totalAkhir)} (${esc(p.statusBayar)})</span>
                  </div>
                  <div class="flex gap-1 shrink-0">
                    ${p.statusDokumen === 'Final' ? `<button type="button" onclick="window.AZI.clearGlobalSearch(); window.AZI.openReceiptModal('PENJUALAN', '${escJs(p.no)}')" class="px-2 py-1 rounded-lg bg-sky-500/20 border border-sky-500/40 text-sky-300 font-bold text-[10px]">🧾 Cek / Print 2x</button>` : ''}
                    <button type="button" onclick="window.AZI.globalJumpTo('penjualan', '${escJs(p.no)}')" class="px-2 py-1 rounded-lg bg-slate-800 text-slate-200 font-bold text-[10px]">Buka</button>
                  </div>
                </div>
              `).join('')}
            </div>
          `);
        }
      }

      // 2. Cari Servis (SRV-...)
      if (akses.menus.includes('servis')) {
        const srvHits = db.servis.filter((s) => {
          if (!akses.semua_transaksi && s.teknisi !== currentUser.username && s.petugasTerima !== currentUser.username) return false;
          return String(s.no).toLowerCase().includes(q) || String(s.pelanggan).toLowerCase().includes(q) || String(s.kontak).toLowerCase().includes(q) || String(s.merekModel).toLowerCase().includes(q) || String(s.jenisServis).toLowerCase().includes(q);
        }).slice(0, 5);
        if (srvHits.length) {
          sections.push(`
            <div>
              <div class="text-[10px] font-extrabold uppercase tracking-wider text-amber-400 px-2 py-1">🛠️ Servis (${srvHits.length})</div>
              ${srvHits.map((s) => `
                <div class="p-2 rounded-xl hover:bg-slate-800/80 flex items-center justify-between gap-2 text-xs">
                  <div class="min-w-0">
                    <span class="font-mono-num font-bold text-amber-300">${esc(s.no)}</span>
                    <span class="text-white font-semibold ml-1.5">${esc(s.pelanggan)} — ${esc(s.merekModel)}</span>
                    <span class="text-sky-300 ml-1 text-[10px]">[${esc(s.statusPengerjaan)}]</span>
                  </div>
                  <div class="flex gap-1 shrink-0">
                    <button type="button" onclick="window.AZI.clearGlobalSearch(); window.AZI.openServiceWorkModal('${escJs(s.no)}')" class="px-2 py-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 font-bold text-[10px]">Update</button>
                    <button type="button" onclick="window.AZI.clearGlobalSearch(); window.AZI.openReceiptModal('${(s.statusPengerjaan === 'Selesai' || s.statusPengerjaan === 'Diambil') ? 'SERVIS_FINAL' : 'SERVIS_TERIMA'}', '${escJs(s.no)}')" class="px-2 py-1 rounded-lg bg-sky-500/20 border border-sky-500/40 text-sky-300 font-bold text-[10px]">🧾 Nota</button>
                  </div>
                </div>
              `).join('')}
            </div>
          `);
        }
      }

      // 3. Cari Pembelian (PB-...)
      if (akses.menus.includes('pembelian')) {
        const pbHits = db.pembelian.filter((pb) => {
          const itemStr = (pb.items || []).map((i) => `${i.sku} ${i.nama}`).join(' ').toLowerCase();
          return String(pb.no).toLowerCase().includes(q) || String(pb.refNota).toLowerCase().includes(q) || String(pb.pemasok).toLowerCase().includes(q) || itemStr.includes(q);
        }).slice(0, 5);
        if (pbHits.length) {
          sections.push(`
            <div>
              <div class="text-[10px] font-extrabold uppercase tracking-wider text-emerald-400 px-2 py-1">🚚 Pembelian (${pbHits.length})</div>
              ${pbHits.map((pb) => `
                <div class="p-2 rounded-xl hover:bg-slate-800/80 flex items-center justify-between gap-2 text-xs">
                  <div class="min-w-0">
                    <span class="font-mono-num font-bold text-amber-300">${esc(pb.no)}</span>
                    <span class="text-white font-semibold ml-1.5">${esc(pb.pemasok)}</span>
                    <span class="text-slate-400 ml-1 text-[10px]">Ref: ${esc(pb.refNota)} • ${rp(pb.total)}</span>
                  </div>
                  <div class="flex gap-1 shrink-0">
                    <button type="button" onclick="window.AZI.clearGlobalSearch(); window.AZI.openReceiptModal('PEMBELIAN', '${escJs(pb.no)}')" class="px-2 py-1 rounded-lg bg-sky-500/20 border border-sky-500/40 text-sky-300 font-bold text-[10px]">🧾 Cek / Print 2x</button>
                    <button type="button" onclick="window.AZI.globalJumpTo('pembelian', '${escJs(pb.no)}')" class="px-2 py-1 rounded-lg bg-slate-800 text-slate-200 font-bold text-[10px]">Buka</button>
                  </div>
                </div>
              `).join('')}
            </div>
          `);
        }
      }

      // 4. Cari Barang / Kode SKU / Barcode
      if (akses.menus.includes('stok') || akses.menus.includes('penjualan')) {
        const brgHits = db.barang.filter((b) =>
          String(b.sku).toLowerCase().includes(q) ||
          String(b.barcode || '').toLowerCase().includes(q) ||
          String(b.nama).toLowerCase().includes(q) ||
          String(b.kategori).toLowerCase().includes(q)
        ).slice(0, 6);
        if (brgHits.length) {
          sections.push(`
            <div>
              <div class="text-[10px] font-extrabold uppercase tracking-wider text-indigo-300 px-2 py-1">📦 Barang & Kode SKU (${brgHits.length})</div>
              ${brgHits.map((b) => {
                const stok = getStokAkhir(b);
                return `
                  <div class="p-2 rounded-xl hover:bg-slate-800/80 flex items-center justify-between gap-2 text-xs">
                    <div class="min-w-0">
                      <span class="font-mono-num font-bold text-sky-400">${esc(b.sku)}</span>
                      <span class="text-white font-semibold ml-1.5">${esc(b.nama)}</span>
                      <span class="ml-1.5 font-mono-num text-[11px] ${stok > 0 ? 'text-emerald-400' : 'text-rose-400'}">Stok: ${stok}</span>
                      <span class="ml-1 font-mono-num text-amber-300 font-bold">${rp(b.hargaJual)}</span>
                    </div>
                    <div class="flex gap-1 shrink-0">
                      ${akses.menus.includes('penjualan') && b.aktif && stok > 0 ? `<button type="button" onclick="window.AZI.clearGlobalSearch(); window.AZI.navigate('penjualan'); window.AZI.addToPosCart('${escJs(b.sku)}')" class="px-2 py-1 rounded-lg btn-luxury text-[10px]">+ Kasir</button>` : ''}
                      ${akses.menus.includes('stok') ? `<button type="button" onclick="window.AZI.globalJumpTo('stok', '${escJs(b.sku)}')" class="px-2 py-1 rounded-lg bg-slate-800 text-slate-200 font-bold text-[10px]">Cek Stok</button>` : ''}
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          `);
        }
      }

      box.innerHTML = sections.length
        ? sections.join('<div class="border-t border-slate-800"></div>')
        : `<div class="p-3 text-center text-xs text-slate-400">Tidak ditemukan transaksi, servis, pembelian, atau barang dengan kata kunci "${esc(globalSearchQuery)}".</div>`;
      box.classList.remove('hidden');
    },

    clearGlobalSearch() {
      globalSearchQuery = '';
      const inp = document.getElementById('global-quick-search');
      const box = document.getElementById('global-search-dropdown');
      const clr = document.getElementById('global-search-clear');
      if (inp) inp.value = '';
      if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
      if (clr) clr.classList.add('hidden');
    },

    globalJumpTo(menuId, filterText) {
      if (menuId === 'penjualan') salesHistoryQuery = filterText;
      else if (menuId === 'servis') servisSearchQuery = filterText;
      else if (menuId === 'pembelian') pembelianSearchQuery = filterText;
      else if (menuId === 'stok') stokSearchQuery = filterText;
      this.clearGlobalSearch();
      this.navigate(menuId);
    },

    quickRestockFromAlert(sku) {
      if (!requirePerm(currentUser.akses.menus.includes('pembelian'), 'Akses ditolak untuk menu Pembelian.')) return;
      pbSelectedSku = sku;
      pbItemSearchQuery = '';
      this.navigate('pembelian');
      showToast(`Barang ${sku} siap dicatat masuk di menu Pembelian!`, 'info');
    },

    // Dialog Konfirmasi Cerdas Anti-Salah-Input
    openConfirmModal(title, messageHtml, onConfirmFn) {
      pendingConfirmFn = onConfirmFn;
      openModal(`
        <div class="glass-card rounded-2xl p-6 max-w-md w-full space-y-4 border border-amber-500/50 text-xs">
          <div class="flex items-center justify-between border-b border-slate-800 pb-2.5">
            <h3 class="text-sm font-extrabold text-amber-300">⚠️ ${esc(title)}</h3>
            <button onclick="window.AZI.closeModal()" class="text-slate-400 hover:text-white text-xl">&times;</button>
          </div>
          <div class="text-slate-200 leading-relaxed space-y-1.5">${messageHtml}</div>
          <div class="grid grid-cols-2 gap-2 pt-2">
            <button type="button" onclick="window.AZI.closeModal()" class="py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold">Batal / Cek Ulang</button>
            <button type="button" onclick="window.AZI.confirmModalAccept()" class="py-2.5 rounded-xl btn-luxury">Ya, Lanjutkan</button>
          </div>
        </div>
      `);
    },

    confirmModalAccept() {
      const fn = pendingConfirmFn;
      pendingConfirmFn = null;
      closeModal();
      if (typeof fn === 'function') fn();
    },

    toggleLoginPassword() {
      const p = document.getElementById('login-password');
      if (p) p.type = p.type === 'password' ? 'text' : 'password';
    },

    async submitLogin(e) {
      e.preventDefault();
      const errBox = document.getElementById('login-error-box');
      const guard = getLoginGuard();
      if (guard.lockUntil && Date.now() < guard.lockUntil) {
        const sisaDetik = Math.ceil((guard.lockUntil - Date.now()) / 1000);
        errBox.textContent = `Terlalu banyak percobaan login gagal. Coba lagi dalam ${sisaDetik} detik.`;
        errBox.classList.remove('hidden');
        return;
      }

      // Tunggu sinkronisasi tarik data awal dari Google Sheet selesai (maks 2.5 detik) agar data & akun selalu terbaru
      let pullDoneOk = false;
      if (initialCloudPullPromise) {
        try {
          const pullRes = await Promise.race([
            initialCloudPullPromise,
            new Promise((r) => setTimeout(() => r({ timeout: true }), 2500))
          ]);
          pullDoneOk = Boolean(pullRes && pullRes.ok);
        } catch (err) {}
      }

      const u = document.getElementById('login-username').value.trim();
      const p = document.getElementById('login-password').value;
      const found = db.karyawan.find((k) => k.username.toLowerCase() === u.toLowerCase() && verifyPassword(p, k.password));
      if (!found) {
        const nextFails = (guard.fails || 0) + 1;
        if (nextFails >= 5) {
          setLoginGuard({ fails: 0, lockUntil: Date.now() + 60000 });
          saveLocalOnly('LOGIN_LOCKED', u || 'UNKNOWN', '5x percobaan login gagal (kunci 60 detik)');
          errBox.textContent = 'Terlalu banyak percobaan gagal. Login dikunci sementara selama 60 detik.';
        } else {
          setLoginGuard({ fails: nextFails, lockUntil: 0 });
          errBox.textContent = `Username atau password salah (${nextFails}/5). Data toko tetap terkunci.`;
        }
        errBox.classList.remove('hidden');
        return;
      }
      if (!found.aktif) {
        errBox.textContent = 'Akun ini telah dinonaktifkan oleh Pemilik. Silakan hubungi Pemilik Toko.';
        errBox.classList.remove('hidden');
        return;
      }

      // Reset brute-force counter & auto-upgrade password lama (plaintext) ke SHA-256
      setLoginGuard({ fails: 0, lockUntil: 0 });
      let passwordUpgraded = false;
      if (!String(found.password || '').startsWith('sha256:')) {
        found.password = hashPassword(p);
        passwordUpgraded = true;
      }

      saveSession(found);
      activeMenu = found.akses.menus[0] || 'dashboard';
      // Simpan log login di lokal tanpa menimpa Google Sheet dengan cache lama
      saveLocalOnly('LOGIN_SUCCESS', found.username, `Login sebagai ${found.jabatan}`);
      if (passwordUpgraded && pullDoneOk) {
        syncToGoogleSheets('UPGRADE_PASSWORD_HASH', found.username, 'Auto-upgrade SHA-256');
      }
      showToast(`Selamat datang, ${found.nama} (${found.jabatan})!`, 'success');
      renderApp();
    },

    logout() {
      // Bersihkan seluruh state sensitif dari memori saat keluar
      posCart = [];
      posServices = [];
      posDiscount = 0;
      posCustomer = '';
      posContact = '';
      posNote = '';
      posPaidOverride = null;
      globalSearchQuery = '';
      salesHistoryQuery = '';
      servisSearchQuery = '';
      stokSearchQuery = '';
      mutasiSearchQuery = '';
      pembelianSearchQuery = '';
      pembayaranSearchQuery = '';
      kasSearchQuery = '';
      pbItemSearchQuery = '';
      editingBarangSku = '';
      editingServiceDraft = null;
      lastReceiptBlePayload = null;
      lastReceiptBleCopy2 = null;
      lastReceiptMeta = null;
      pendingConfirmFn = null;
      saveSession(null);
      showToast('Anda telah keluar dari sesi Azi Cell.', 'info');
      renderApp();
    },

    submitNewPassword(e, shouldCloseModal = false) {
      e.preventDefault();
      const p1 = document.getElementById('new-pass-1').value;
      const p2 = document.getElementById('new-pass-2').value;
      if (p1.length < 4) {
        showToast('Password baru minimal 4 karakter demi keamanan akun!', 'error');
        return;
      }
      if (p1 !== p2) {
        showToast('Konfirmasi password tidak cocok!', 'error');
        return;
      }
      const userObj = db.karyawan.find((k) => k.username === currentUser.username);
      if (userObj) {
        userObj.password = hashPassword(p1);
        userObj.wajibGantiPassword = false;
        saveDatabase('CHANGE_PASSWORD', userObj.username, 'Ganti password akun (SHA-256)');
        saveSession(userObj);
        if (shouldCloseModal) closeModal();
        showToast('Password baru berhasil dienkripsi & disimpan!', 'success');
        renderApp();
      }
    },

    openChangePasswordModal() {
      openModal(`
        <div class="glass-card rounded-2xl p-6 max-w-sm w-full space-y-3">
          <h3 class="text-sm font-extrabold text-white">Ganti Password Akun</h3>
          <form onsubmit="window.AZI.submitNewPassword(event, true)" class="space-y-3 text-xs">
            <input id="new-pass-1" type="password" required minlength="4" placeholder="Password Baru" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
            <input id="new-pass-2" type="password" required minlength="4" placeholder="Ulangi Password Baru" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white" />
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
    // POS KASIR ACTIONS (BARANG + JASA / ONGKOS PASANG + BARCODE ENTER + FILTER)
    // ========================================================================
    filterPosCatalog(query) {
      posSearchQuery = String(query || '');
      const grid = document.getElementById('pos-catalog-grid');
      if (grid) grid.innerHTML = renderPosCatalogCards(posSearchQuery);
    },

    handlePosSearchEnter(e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = String(posSearchQuery || '').trim().toLowerCase();
      if (!q) return;
      const exact = db.barang.find((b) =>
        b.aktif && (String(b.sku).toLowerCase() === q || String(b.barcode || '').toLowerCase() === q)
      );
      const matches = exact ? [exact] : db.barang.filter((b) =>
        b.aktif && (String(b.sku).toLowerCase().includes(q) || String(b.barcode || '').toLowerCase().includes(q) || String(b.nama).toLowerCase().includes(q))
      );
      if (matches.length === 1) {
        const added = this.addToPosCart(matches[0].sku);
        if (added) {
          posSearchQuery = '';
          renderApp();
          showToast(`${matches[0].nama} otomatis masuk ke keranjang!`, 'success');
          const sInp = document.getElementById('pos-search');
          if (sInp) sInp.focus();
        }
      } else if (matches.length === 0) {
        showToast(`Kode "${posSearchQuery}" tidak ditemukan di katalog aktif.`, 'warn');
      }
    },

    filterSalesHistory(query) {
      salesHistoryQuery = String(query || '');
      const tbody = document.getElementById('sales-history-tbody');
      if (tbody) tbody.innerHTML = renderSalesHistoryRows(salesHistoryQuery);
    },

    setPosField(field, value) {
      if (field === 'customer') posCustomer = value;
      else if (field === 'contact') posContact = value;
      else if (field === 'accountId') posAccountId = value;
      else if (field === 'note') posNote = value;
    },

    addToPosCart(sku) {
      const item = db.barang.find((b) => b.sku === sku && b.aktif);
      if (!item) return false;
      const stokTersedia = getStokAkhir(item);
      const existing = posCart.find((c) => c.sku === sku);
      const nextQty = existing ? existing.qty + 1 : 1;
      if (nextQty > stokTersedia) {
        showToast(`Stok ${item.nama} tidak mencukupi (Tersisa ${stokTersedia} ${item.satuan})!`, 'error');
        return false;
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
      return true;
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

    savePosTransaction(statusDokumen, skipTypoConfirm = false) {
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

      // Cek deteksi typo nol berlebih / diskon ekstrem sebelum finalisasi (Anti Human Error!)
      if (statusDokumen === 'Final' && !skipTypoConfirm) {
        const subBrgCheck = posCart.reduce((s, i) => s + i.qty * i.hargaJual, 0);
        const totJasaCheck = cleanServices.reduce((s, j) => s + j.biaya, 0);
        const subCheck = subBrgCheck + totJasaCheck;
        const diskCheck = Math.min(subCheck, Math.max(0, Number(posDiscount) || 0));
        const totCheck = Math.max(0, subCheck - diskCheck);
        const uangCheck = Math.max(0, Number((document.getElementById('pos-uang-diterima') || {}).value) || 0);
        const typoUang = totCheck > 0 && uangCheck > Math.max(totCheck * 5, totCheck + 500000);
        const diskonBesar = subCheck > 0 && diskCheck > subCheck * 0.5;
        if (typoUang || diskonBesar) {
          const reason = typoUang
            ? `Uang diterima <b>${rp(uangCheck)}</b> jauh lebih besar dari Total <b>${rp(totCheck)}</b> (Kembalian <b>${rp(uangCheck - totCheck)}</b>). Pastikan tidak kelebihan mengetik angka 0!`
            : `Diskon <b>${rp(diskCheck)}</b> melebihi 50% dari Subtotal <b>${rp(subCheck)}</b>. Pastikan nominal diskon sudah benar!`;
          this.openConfirmModal('Konfirmasi Nominal Transaksi', `<p>${reason}</p><p class="text-slate-400">Lanjutkan simpan transaksi ini?</p>`, () => {
            this.savePosTransaction('Final', true);
          });
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
    // SERVIS ACTIONS (STEPPER 1-KLIK + MULTI SPAREPART + MULTI JASA)
    // ========================================================================
    filterServisList(query) {
      servisSearchQuery = String(query || '');
      const wrap = document.getElementById('servis-cards-list');
      if (wrap) wrap.innerHTML = renderServisCardsList(servisSearchQuery);
    },

    quickAdvanceService(noSrv, targetStatus) {
      const s = db.servis.find((x) => x.no === noSrv);
      if (!s) return;
      s.statusPengerjaan = targetStatus;
      saveDatabase('UPDATE_SERVICE_STATUS', s.no, `Status -> ${targetStatus}`);
      showToast(`Servis ${s.no} sekarang berstatus "${targetStatus}"!`, 'success');
      renderApp();
    },

    quickHandoverService(noSrv) {
      const s = db.servis.find((x) => x.no === noSrv);
      if (!s) return;
      if (s.sisaTagihan > 0) {
        this.openConfirmModal(
          'Tagihan Servis Belum Lunas!',
          `<p>Unit <b>${esc(s.merekModel)}</b> milik <b>${esc(s.pelanggan)}</b> masih memiliki sisa tagihan <b class="text-rose-400 font-mono-num">${rp(s.sisaTagihan)}</b>.</p>
           <p>Apakah Anda yakin tetap menyerahkan unit sebagai <b>Piutang / Belum Lunas</b>? (Atau klik Batal lalu tekan tombol <b>💳 Lunasi</b> terlebih dahulu.)</p>`,
          () => {
            s.statusPengerjaan = 'Diambil';
            s.tanggalDiambil = nowStr();
            saveDatabase('HANDOVER_SERVICE_UNPAID', s.no, `Diambil dengan sisa tagihan ${rp(s.sisaTagihan)}`);
            showToast(`Servis ${s.no} ditandai Diambil (Sisa piutang ${rp(s.sisaTagihan)}).`, 'warn');
            renderApp();
          }
        );
        return;
      }
      s.statusPengerjaan = 'Diambil';
      s.tanggalDiambil = nowStr();
      saveDatabase('HANDOVER_SERVICE', s.no, 'Unit diserahkan ke pelanggan (Lunas)');
      showToast(`Servis ${s.no} berhasil diserahkan (Status: Diambil & Lunas)!`, 'success');
      renderApp();
      openReceiptModal('SERVIS_FINAL', s.no);
    },

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

    openServiceWorkModal(noSrv, presetStatus = null) {
      const s = db.servis.find((x) => x.no === noSrv);
      if (!s) return;
      const existingJasa = (Array.isArray(s.jasaItems) && s.jasaItems.length > 0)
        ? JSON.parse(JSON.stringify(s.jasaItems))
        : [{ nama: s.namaJasa || s.jenisServis || 'Jasa Servis', biaya: Number(s.biayaJasa) || 0 }];
      editingServiceDraft = {
        no: s.no,
        statusPengerjaan: presetStatus || s.statusPengerjaan,
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

          <form onsubmit="window.AZI.saveServiceProgress(event, '${escJs(d.no)}')" class="space-y-3.5">
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
              <input id="upd-srv-part-search" type="text" oninput="window.AZI.filterModalServiceParts(this.value)" placeholder="🔍 Ketik Kode SKU / Nama Spare Part (mis: LCD, Baterai)..." class="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-sky-500/40 text-white text-[11px]" />
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

    filterModalServiceParts(query) {
      const sel = document.getElementById('upd-srv-part-sku');
      if (!sel) return;
      const q = String(query || '').trim().toLowerCase();
      const list = db.barang.filter((b) => {
        if (!b.aktif) return false;
        if (!q) return true;
        return String(b.sku).toLowerCase().includes(q) || String(b.barcode || '').toLowerCase().includes(q) || String(b.nama).toLowerCase().includes(q);
      });
      sel.innerHTML = (list.length === 1 ? '' : '<option value="">-- Pilih Spare Part (' + list.length + ') --</option>') +
        list.map((b) => `<option value="${esc(b.sku)}">${esc(b.sku)} — ${esc(b.nama)} (${rp(b.hargaJual)} | Stok: ${getStokAkhir(b)})</option>`).join('');
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
      if (!item) {
        showToast('Spare part tidak ditemukan di Master Barang!', 'warn');
        return;
      }
      const alreadyPendingQty = editingServiceDraft.spareparts
        .filter((sp) => sp.sku === sku && !sp.terpotong)
        .reduce((sum, sp) => sum + (Number(sp.qty) || 0), 0);
      if (alreadyPendingQty + qty > getStokAkhir(item)) {
        showToast(`Stok ${item.nama} tidak mencukupi (Tersisa ${getStokAkhir(item)})!`, 'error');
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
    // STOK & PEMBELIAN ACTIONS (AUTO-SUGGEST + ANTI-HUMAN-ERROR)
    // ========================================================================
    filterStokTable(query) {
      stokSearchQuery = String(query || '');
      const tbody = document.getElementById('stok-table-body');
      if (tbody) tbody.innerHTML = renderStokTableRows(stokSearchQuery);
    },

    filterMutasiTable(query) {
      mutasiSearchQuery = String(query || '');
      const tbody = document.getElementById('mutasi-table-body');
      if (tbody) tbody.innerHTML = renderMutasiRows(mutasiSearchQuery);
    },

    handleMasterSkuSuggest(query) {
      const box = document.getElementById('brg-sku-suggest');
      if (!box) return;
      const q = String(query || '').trim().toLowerCase();
      if (!q) {
        box.classList.add('hidden');
        box.innerHTML = '';
        return;
      }
      const hits = db.barang.filter((b) =>
        String(b.sku).toLowerCase().includes(q) ||
        String(b.barcode || '').toLowerCase().includes(q) ||
        String(b.nama).toLowerCase().includes(q)
      ).slice(0, 5);
      if (hits.length === 0) {
        box.classList.add('hidden');
        box.innerHTML = '';
        return;
      }
      box.innerHTML = `<div class="text-[10px] text-amber-300 font-bold px-1">⚠️ Barang serupa sudah terdaftar (klik untuk Edit agar tidak duplikat):</div>` +
        hits.map((b) => `
          <button type="button" onclick="window.AZI.editMasterBarang('${escJs(b.sku)}')" class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-slate-800 flex items-center justify-between gap-2 text-[11px]">
            <span><b class="font-mono-num text-sky-400">${esc(b.sku)}</b> — ${esc(b.nama)}</span>
            <span class="font-mono-num text-emerald-400">Stok ${getStokAkhir(b)}</span>
          </button>
        `).join('');
      box.classList.remove('hidden');
    },

    checkMasterPriceMargin() {
      const modal = Number((document.getElementById('brg-modal') || {}).value) || 0;
      const jual = Number((document.getElementById('brg-jual') || {}).value) || 0;
      const warn = document.getElementById('brg-margin-warn');
      if (!warn) return;
      if (jual === 0 && modal === 0) {
        warn.classList.add('hidden');
        return;
      }
      if (jual < modal) {
        warn.className = 'p-2 rounded-lg bg-rose-950/70 border border-rose-500/50 text-[11px] font-bold text-rose-200';
        warn.textContent = `⚠️ Peringatan Rugi: Harga Jual (${rp(jual)}) lebih rendah dari Harga Modal (${rp(modal)})! Selisih -${rp(modal - jual)}.`;
      } else {
        const margin = jual - modal;
        const pct = modal > 0 ? Math.round((margin / modal) * 100) : 100;
        warn.className = 'p-2 rounded-lg bg-emerald-950/50 border border-emerald-500/30 text-[11px] font-semibold text-emerald-300';
        warn.textContent = `✅ Margin Laba: +${rp(margin)} (${pct}% dari modal).`;
      }
    },

    resetMasterBarangForm() {
      editingBarangSku = '';
      const form = document.getElementById('form-master-barang');
      if (form) form.reset();
      const banner = document.getElementById('brg-edit-banner');
      if (banner) banner.classList.add('hidden');
      const sug = document.getElementById('brg-sku-suggest');
      if (sug) { sug.classList.add('hidden'); sug.innerHTML = ''; }
      const warn = document.getElementById('brg-margin-warn');
      if (warn) warn.classList.add('hidden');
    },

    recalcStockAdjPreview() {
      const sku = (document.getElementById('adj-sku') || {}).value;
      const jenis = (document.getElementById('adj-jenis') || {}).value;
      const qty = Math.max(0, Number((document.getElementById('adj-qty') || {}).value) || 0);
      const prevEl = document.getElementById('adj-preview');
      const item = db.barang.find((b) => b.sku === sku);
      if (!prevEl || !item) return;
      const sekarang = getStokAkhir(item);
      const sesudah = jenis === 'KELUAR' ? sekarang - qty : sekarang + qty;
      if (sesudah < 0) {
        prevEl.className = 'p-2 rounded-lg bg-rose-950/70 border border-rose-500/50 text-[11px] text-rose-200 font-mono-num font-bold';
        prevEl.textContent = `❌ Ditolak: Stok saat ini ${sekarang}, dikurangi ${qty} akan menjadi minus (${sesudah})!`;
      } else {
        prevEl.className = 'p-2 rounded-lg bg-slate-900/90 border border-sky-500/30 text-[11px] text-sky-300 font-mono-num';
        prevEl.textContent = `Pratinjau Stok: ${sekarang} -> ${sesudah} ${item.satuan} (${jenis === 'KELUAR' ? '-' : '+'}${qty})`;
      }
    },

    editMasterBarang(sku) {
      const b = db.barang.find((x) => x.sku === sku);
      if (!b) return;
      editingBarangSku = b.sku;
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
      const sug = document.getElementById('brg-sku-suggest');
      if (sug) { sug.classList.add('hidden'); sug.innerHTML = ''; }
      const banner = document.getElementById('brg-edit-banner');
      if (banner) {
        banner.classList.remove('hidden');
        const bSpan = banner.querySelector('b');
        if (bSpan) bSpan.textContent = b.sku;
      }
      this.checkMasterPriceMargin();
      showToast(`Mode edit barang ${b.sku}. Ubah data lalu klik Simpan Data Barang.`, 'info');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    toggleBarangActive(sku) {
      if (!requirePerm(canManageStock(), 'Akses ditolak: Hanya Pemilik/Gudang yang dapat mengubah status barang.')) return;
      const b = db.barang.find((x) => x.sku === sku);
      if (!b) return;
      b.aktif = !b.aktif;
      saveDatabase('TOGGLE_ITEM_ACTIVE', sku, `Aktif: ${b.aktif}`);
      showToast(`Barang ${sku} sekarang ${b.aktif ? 'Aktif' : 'Nonaktif'}.`, 'info');
      renderApp();
    },

    submitMasterBarang(e) {
      e.preventDefault();
      if (!requirePerm(canManageStock(), 'Akses ditolak: Hanya Pemilik/Gudang yang dapat mengelola master barang.')) return;
      const sku = document.getElementById('brg-sku').value.trim().toUpperCase();
      if (!/^[A-Z0-9._-]{2,32}$/.test(sku)) {
        showToast('Kode SKU hanya boleh huruf, angka, titik, garis bawah, atau strip (2-32 karakter).', 'error');
        return;
      }
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
      editingBarangSku = '';
      saveDatabase('SAVE_ITEM', sku, nama);
      renderApp();
    },

    submitStockAdjustment(e) {
      e.preventDefault();
      if (!requirePerm(canManageStock(), 'Akses ditolak: Hanya Pemilik/Gudang yang dapat melakukan penyesuaian stok.')) return;
      const sku = document.getElementById('adj-sku').value;
      const jenis = document.getElementById('adj-jenis').value;
      const qty = Number(document.getElementById('adj-qty').value) || 0;
      const alasan = document.getElementById('adj-alasan').value.trim();
      const item = db.barang.find((b) => b.sku === sku);
      if (!item) {
        showToast('Belum ada master barang yang dipilih! Tambahkan barang dulu di menu Barang & Stok.', 'warn');
        return;
      }
      if (qty <= 0) return;

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

    handlePembelianItemSearch(query) {
      pbItemSearchQuery = String(query || '');
      const box = document.getElementById('pb-item-suggest');
      if (!box) return;
      const q = pbItemSearchQuery.trim().toLowerCase();
      if (!q) {
        box.classList.add('hidden');
        box.innerHTML = '';
        return;
      }
      const hits = db.barang.filter((b) =>
        String(b.sku).toLowerCase().includes(q) ||
        String(b.barcode || '').toLowerCase().includes(q) ||
        String(b.nama).toLowerCase().includes(q)
      ).slice(0, 6);
      box.innerHTML = hits.length
        ? hits.map((b) => `
            <button type="button" onclick="window.AZI.selectPembelianItem('${escJs(b.sku)}')" class="w-full text-left px-2.5 py-2 rounded-lg hover:bg-slate-800 flex items-center justify-between gap-2 text-xs">
              <div class="min-w-0">
                <span class="font-mono-num font-bold text-sky-400">${esc(b.sku)}</span>
                <span class="text-white font-semibold ml-1">${esc(b.nama)}</span>
              </div>
              <div class="text-right shrink-0 font-mono-num text-[10px]">
                <div class="text-emerald-400">Stok: ${getStokAkhir(b)}</div>
                <div class="text-amber-300">Modal: ${rp(b.hargaModal)}</div>
              </div>
            </button>
          `).join('')
        : `<div class="p-2 text-center text-[11px] text-slate-400">Barang tidak ditemukan. Tambah dulu di menu Barang & Stok.</div>`;
      box.classList.remove('hidden');
    },

    selectPembelianItem(sku) {
      pbSelectedSku = sku;
      pbItemSearchQuery = '';
      const inp = document.getElementById('pb-item-search');
      const box = document.getElementById('pb-item-suggest');
      const sel = document.getElementById('pb-sku');
      if (inp) inp.value = '';
      if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
      if (sel) sel.value = sku;
      this.onPembelianItemChange(sku);
    },

    filterPembelianHistory(query) {
      pembelianSearchQuery = String(query || '');
      const tbody = document.getElementById('pb-history-tbody');
      if (tbody) tbody.innerHTML = renderPembelianHistoryRows(pembelianSearchQuery);
    },

    onPembelianItemChange(sku) {
      pbSelectedSku = sku;
      const item = db.barang.find((b) => b.sku === sku);
      const hargaEl = document.getElementById('pb-harga');
      const pemasokEl = document.getElementById('pb-pemasok');
      if (item && hargaEl) {
        hargaEl.value = Number(item.hargaModal) || 0;
        if (pemasokEl && item.pemasok && item.pemasok !== '-') {
          pemasokEl.value = item.pemasok;
        }
        this.recalcPembelianTotal(true);
      }
    },

    recalcPembelianTotal(syncPaid) {
      const sku = (document.getElementById('pb-sku') || {}).value;
      const item = db.barang.find((b) => b.sku === sku);
      const qty = Math.max(0, Number((document.getElementById('pb-qty') || {}).value) || 0);
      const harga = Math.max(0, Number((document.getElementById('pb-harga') || {}).value) || 0);
      const total = qty * harga;
      const totalEl = document.getElementById('pb-total-preview');
      const stockEl = document.getElementById('pb-stock-preview');
      const dibayarEl = document.getElementById('pb-dibayar');
      const utangEl = document.getElementById('pb-utang-preview');
      if (totalEl) totalEl.textContent = rp(total);
      if (stockEl && item) {
        const stokLama = Math.max(0, getStokAkhir(item));
        const modalBaru = (stokLama + qty) > 0
          ? Math.round((stokLama * (Number(item.hargaModal) || 0) + qty * harga) / (stokLama + qty))
          : harga;
        stockEl.textContent = `Pratinjau Stok: ${stokLama} -> ${stokLama + qty} ${item.satuan} | Modal Rata-rata Baru: ${rp(modalBaru)}`;
      }
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
      if (!requirePerm(currentUser.akses.menus.includes('pembelian'), 'Akses ditolak: Anda tidak memiliki izin mencatat pembelian.')) return;
      const pemasok = document.getElementById('pb-pemasok').value.trim();
      const refNota = document.getElementById('pb-ref').value.trim();
      const sku = document.getElementById('pb-sku').value;
      const qty = Number(document.getElementById('pb-qty').value) || 0;
      const hargaBeli = Math.max(0, Number(document.getElementById('pb-harga').value) || 0);
      const dibayar = Math.max(0, Number(document.getElementById('pb-dibayar').value) || 0);
      const akunId = document.getElementById('pb-akun').value;

      const item = db.barang.find((b) => b.sku === sku);
      if (!item) {
        showToast('Belum ada master barang yang dipilih! Tambahkan barang dulu di menu Barang & Stok.', 'warn');
        return;
      }
      if (qty <= 0) return;

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
      showToast(`Pembelian ${noPb} tersimpan! Stok bertambah ${qty} ${item.satuan}.`, 'success');
      renderApp();
      openReceiptModal('PEMBELIAN', noPb);
    },

    // ========================================================================
    // PELUNASAN PIUTANG / UTANG (BAB 09 — LIVE SEARCH + QUICK PAY + PREVIEW)
    // ========================================================================
    filterPembayaranView(query) {
      pembayaranSearchQuery = String(query || '');
      const wrap = document.getElementById('pembayaran-content-wrap');
      if (wrap) wrap.innerHTML = renderPembayaranSectionsHtml(pembayaranSearchQuery);
    },

    openPayModal(jenis, noRef, sisa) {
      const sisaNum = Number(sisa) || 0;
      const halfNum = Math.ceil(sisaNum / 2);
      openModal(`
        <div class="glass-card rounded-2xl p-6 max-w-sm w-full space-y-3 text-xs">
          <h3 class="text-sm font-extrabold text-white">Catat Pelunasan ${esc(noRef)}</h3>
          <p class="text-slate-300">Sisa Tagihan Saat Ini: <b class="text-rose-400 font-mono-num">${rp(sisaNum)}</b></p>
          <form onsubmit="window.AZI.submitPelunasan(event, '${escJs(jenis)}', '${escJs(noRef)}', ${sisaNum})" class="space-y-3">
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="text-[10px] text-slate-400">Nominal Pembayaran (Rp) *</label>
                <div class="flex gap-1">
                  <button type="button" onclick="window.AZI.setPayQuickNominal(${halfNum}, ${sisaNum})" class="px-1.5 py-0.5 rounded bg-slate-800 text-amber-300 font-bold text-[10px]">50%</button>
                  <button type="button" onclick="window.AZI.setPayQuickNominal(${sisaNum}, ${sisaNum})" class="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold text-[10px]">Lunas 100%</button>
                </div>
              </div>
              <input id="pay-nominal" type="number" min="1" max="${sisaNum}" required value="${sisaNum}" oninput="window.AZI.recalcPayRemaining(${sisaNum})" class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-emerald-500/50 text-emerald-300 font-mono-num font-bold" />
              <div id="pay-remain-preview" class="mt-1 text-[10px] text-emerald-400 font-mono-num">Sisa setelah bayar: Rp0 (LUNAS)</div>
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

    setPayQuickNominal(nom, sisaMaks) {
      const el = document.getElementById('pay-nominal');
      if (el) el.value = nom;
      this.recalcPayRemaining(sisaMaks);
    },

    recalcPayRemaining(sisaMaks) {
      const nom = Math.max(0, Number((document.getElementById('pay-nominal') || {}).value) || 0);
      const prev = document.getElementById('pay-remain-preview');
      if (!prev) return;
      if (nom > sisaMaks) {
        prev.className = 'mt-1 text-[10px] text-rose-400 font-mono-num font-bold';
        prev.textContent = `❌ Melebihi sisa tagihan (${rp(sisaMaks)})!`;
      } else {
        const sisaAkhir = Math.max(0, sisaMaks - nom);
        prev.className = sisaAkhir === 0 ? 'mt-1 text-[10px] text-emerald-400 font-mono-num font-bold' : 'mt-1 text-[10px] text-amber-300 font-mono-num';
        prev.textContent = sisaAkhir === 0 ? 'Sisa setelah bayar: Rp0 (LUNAS)' : `Sisa setelah bayar: ${rp(sisaAkhir)} (Sebagian)`;
      }
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
    filterKasHistory(query) {
      kasSearchQuery = String(query || '');
      const tbody = document.getElementById('kas-history-tbody');
      if (tbody) tbody.innerHTML = renderKasHistoryRows(kasSearchQuery);
    },

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
      if (!requirePerm(currentUser.akses.menus.includes('kas'), 'Akses ditolak: Anda tidak memiliki izin mencatat mutasi kas.')) return;
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
    // RETUR & KOREKSI (BAB 13 — AUTO-SEARCH TRANSAKSI ASAL + ANTI SALAH KETIK)
    // ========================================================================
    handleReturRefSearch(query) {
      const box = document.getElementById('ret-ref-suggest');
      const badge = document.getElementById('ret-ref-badge');
      const jenisEl = document.getElementById('ret-jenis');
      if (!box || !jenisEl) return;
      const jenis = jenisEl.value;
      const q = String(query || '').trim().toLowerCase();

      const sourceList = jenis === 'Retur Penjualan'
        ? db.penjualan.filter((p) => p.statusDokumen === 'Final')
        : db.pembelian;

      const exact = sourceList.find((x) => String(x.no).toLowerCase() === q);
      if (badge) {
        if (!q) {
          badge.className = 'mt-1 text-[10px] text-slate-400';
          badge.textContent = 'Ketik nomor transaksi untuk memilih otomatis tanpa salah ketik.';
        } else if (exact) {
          badge.className = 'mt-1 text-[10px] text-emerald-400 font-bold';
          badge.textContent = `✅ Transaksi ${exact.no} terverifikasi (${exact.pelanggan || exact.pemasok} — Total ${rp(exact.totalAkhir !== undefined ? exact.totalAkhir : exact.total)})`;
        } else {
          badge.className = 'mt-1 text-[10px] text-amber-300 font-semibold';
          badge.textContent = '⚠️ Pilih salah satu transaksi yang muncul di daftar agar nomor pasti valid.';
        }
      }

      if (!q) {
        box.classList.add('hidden');
        box.innerHTML = '';
        return;
      }

      const hits = sourceList.filter((x) => {
        const who = x.pelanggan || x.pemasok || '';
        const itemTxt = (x.items || []).map((i) => `${i.sku} ${i.nama}`).join(' ').toLowerCase();
        return String(x.no).toLowerCase().includes(q) || who.toLowerCase().includes(q) || itemTxt.includes(q);
      }).slice(0, 6);

      box.innerHTML = hits.length
        ? hits.map((x) => {
            const firstItem = (x.items || [])[0] || {};
            const total = x.totalAkhir !== undefined ? x.totalAkhir : x.total;
            const who = x.pelanggan || x.pemasok || '-';
            return `
              <button type="button" onclick="window.AZI.selectReturTransaction('${escJs(x.no)}')" class="w-full text-left px-2.5 py-2 rounded-lg hover:bg-slate-800 flex items-center justify-between gap-2 text-xs">
                <div class="min-w-0">
                  <span class="font-mono-num font-bold text-amber-300">${esc(x.no)}</span>
                  <span class="text-white font-semibold ml-1">${esc(who)}</span>
                  <div class="text-[10px] text-slate-400 truncate">${esc(firstItem.nama || '-')} (${firstItem.qty || 1}x)</div>
                </div>
                <div class="text-right shrink-0 font-mono-num text-[10px]">
                  <div class="text-emerald-300 font-bold">${rp(total)}</div>
                  <div class="text-sky-300">${esc(x.statusBayar || '')}</div>
                </div>
              </button>
            `;
          }).join('')
        : `<div class="p-2 text-center text-[11px] text-rose-300">Nomor transaksi "${esc(query)}" tidak ditemukan pada data ${esc(jenis)}.</div>`;
      box.classList.remove('hidden');
    },

    selectReturTransaction(noRef) {
      const jenis = (document.getElementById('ret-jenis') || {}).value;
      const trx = jenis === 'Retur Penjualan'
        ? db.penjualan.find((p) => p.no === noRef)
        : db.pembelian.find((pb) => pb.no === noRef);
      const refEl = document.getElementById('ret-noref');
      const box = document.getElementById('ret-ref-suggest');
      if (refEl) refEl.value = noRef;
      if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
      if (!trx) return;

      const firstItem = (trx.items || [])[0];
      const skuEl = document.getElementById('ret-sku');
      const qtyEl = document.getElementById('ret-qty');
      const nomEl = document.getElementById('ret-nominal');
      const metEl = document.getElementById('ret-metode');
      if (firstItem && skuEl) skuEl.value = firstItem.sku;
      if (qtyEl) qtyEl.value = 1;
      if (nomEl) {
        const unitPrice = firstItem ? (Number(firstItem.hargaJual !== undefined ? firstItem.hargaJual : firstItem.hargaBeli) || 0) : 0;
        nomEl.value = unitPrice;
      }
      if (metEl) {
        const hasUnpaid = (Number(trx.sisaPiutang) || Number(trx.sisaUtang) || 0) > 0;
        metEl.value = hasUnpaid ? 'Potong Tagihan' : 'Refund Kas';
      }
      this.handleReturRefSearch(noRef);
      if (box) box.classList.add('hidden');
      showToast(`Data transaksi ${noRef} otomatis terisi! Cek jumlah & alasan retur.`, 'success');
    },

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
      if (!item) {
        showToast('Belum ada master barang yang valid untuk diretur!', 'warn');
        return;
      }

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
      if (!requirePerm(currentUser.akses.kelola_karyawan, 'Akses ditolak: Hanya Pemilik yang dapat mengelola karyawan.')) return;
      const u = db.karyawan.find((k) => k.username === username);
      if (!u) return;
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      const setCb = (id, v) => { const el = document.getElementById(id); if (el) el.checked = Boolean(v); };
      setVal('usr-nama', u.nama);
      setVal('usr-username', u.username);
      setVal('usr-kontak', u.kontak === '-' ? '' : (u.kontak || ''));
      setVal('usr-jabatan', u.jabatan);
      // Keamanan: jangan tampilkan password/hash lama di form; kosongkan kecuali ingin mengganti
      setVal('usr-pass', '');
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
      showToast(`Mode edit akun @${u.username}. Kosongkan password jika tidak ingin mengganti sandi.`, 'info');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    submitKaryawan(e) {
      e.preventDefault();
      if (!requirePerm(currentUser.akses.kelola_karyawan, 'Akses ditolak: Hanya Pemilik yang dapat mengelola akun karyawan.')) return;
      const nama = document.getElementById('usr-nama').value.trim();
      const username = document.getElementById('usr-username').value.trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        showToast('Username harus 3-32 karakter (hanya huruf kecil, angka, titik, underscore, atau strip).', 'error');
        return;
      }
      const kontak = ((document.getElementById('usr-kontak') && document.getElementById('usr-kontak').value) || '').trim() || '-';
      const jabatan = document.getElementById('usr-jabatan').value;
      const rawPassword = document.getElementById('usr-pass').value;
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
        if (rawPassword && rawPassword.trim() !== '') {
          if (rawPassword.length < 4) {
            showToast('Password baru minimal 4 karakter!', 'error');
            return;
          }
          existing.password = hashPassword(rawPassword);
        }
        existing.wajibGantiPassword = wajibGantiPassword;
        existing.akses = akses;
        showToast(`Akun & hak akses @${username} diperbarui!`, 'success');
      } else {
        if (!rawPassword || rawPassword.length < 4) {
          showToast('Akun baru wajib diisi password sementara minimal 4 karakter!', 'error');
          return;
        }
        db.karyawan.push({
          id: nextSeqNo('USR', db.karyawan, 'id', 2),
          username,
          password: hashPassword(rawPassword),
          nama,
          jabatan,
          kontak,
          aktif: true,
          wajibGantiPassword,
          akses,
          dibuatPada: nowStr()
        });
        showToast(`Akun karyawan @${username} berhasil ditambahkan!`, 'success');
      }
      saveDatabase('UPDATE_USER_ACCESS', username, jabatan);
      renderApp();
    },

    toggleUserActive(username) {
      if (!requirePerm(currentUser.akses.kelola_karyawan, 'Akses ditolak: Hanya Pemilik yang dapat mengubah status akun.')) return;
      const target = db.karyawan.find((u) => u.username === username);
      if (!target) return;
      const activeOwners = db.karyawan.filter((u) => u.jabatan === 'Pemilik' && u.aktif);
      if (target.jabatan === 'Pemilik' && target.aktif && activeOwners.length <= 1) {
        showToast('Tidak dapat menonaktifkan akun Pemilik terakhir!', 'error');
        return;
      }
      target.aktif = !target.aktif;
      saveDatabase('TOGGLE_USER_ACTIVE', username, `Aktif: ${target.aktif}`);
      showToast(`Status akun @${username} diubah menjadi ${target.aktif ? 'Aktif' : 'Nonaktif'}.`, 'info');
      renderApp();
    },

    resetUserPassword(username) {
      if (!requirePerm(currentUser.akses.kelola_karyawan, 'Akses ditolak: Hanya Pemilik yang dapat mereset sandi karyawan.')) return;
      const target = db.karyawan.find((u) => u.username === username);
      if (!target) return;
      target.password = hashPassword('1234');
      target.wajibGantiPassword = true;
      saveDatabase('RESET_PASSWORD', username, 'Reset ke sandi sementara & wajib ganti saat login');
      showToast(`Password @${username} direset ke "1234" (Wajib ganti saat login pertama).`, 'success');
    },

    // ========================================================================
    // PENGATURAN, CLOUD SYNC DUA ARAH & BACKUP/RESTORE JSON
    // ========================================================================
    saveOwnerDatabaseConfig(e) {
      e.preventDefault();
      if (!requirePerm(currentUser.akses.menus.includes('pengaturan'), 'Akses ditolak untuk mengubah konfigurasi cloud.')) return;
      const rawUrl = document.getElementById('cfg-sheet-url').value.trim();
      const gasUrl = document.getElementById('cfg-gas-url').value.trim();
      if (gasUrl && !/^https:\/\/script\.google\.com\//i.test(gasUrl)) {
        showToast('URL Web App Apps Script harus dimulai dengan https://script.google.com/', 'error');
        return;
      }
      const match = rawUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      db.config.spreadsheetUrl = rawUrl;
      db.config.spreadsheetId = match ? match[1] : rawUrl;
      db.config.gasWebAppUrl = gasUrl;
      saveDatabase('CHANGE_OWNER_SPREADSHEET', 'SPREADSHEET', 'Update konfigurasi Spreadsheet pemilik');
      showToast('Konfigurasi Spreadsheet Pemilik berhasil disimpan!', 'success');
      renderApp();
    },

    async triggerRemoteSheetSetup() {
      if (!requirePerm(currentUser.akses.menus.includes('pengaturan'), 'Akses ditolak.')) return;
      if (!db.config.gasWebAppUrl) {
        showToast('Isi URL Web App Google Apps Script terlebih dahulu, atau jalankan setupDatabaseOtomatis() di Code.gs!', 'warn');
        return;
      }
      showToast('Mengirim perintah pembuatan 12 Sheet & Header otomatis...', 'info');
      await syncToGoogleSheets('AUTO_SETUP_SHEETS', '12_SHEETS', 'Setup otomatis 12 sheet & header kolom', true);
      renderApp();
    },

    async pushAllToSheets() {
      if (!requirePerm(currentUser.akses.menus.includes('pengaturan'), 'Akses ditolak.')) return;
      if (!db.config.gasWebAppUrl) {
        showToast('Isi URL Web App Google Apps Script di atas terlebih dahulu!', 'warn');
        return;
      }
      showToast('Mengirim seluruh 12 Sheet data ke Google Spreadsheet...', 'info');
      await syncToGoogleSheets('MANUAL_PUSH_ALL', '12_SHEETS', 'Sinkronisasi manual seluruh data', true);
      renderApp();
    },

    pullFromGoogleSheets() {
      if (!requirePerm(currentUser.akses.menus.includes('pengaturan'), 'Akses ditolak.')) return;
      return pullFromGoogleSheets({ silent: false });
    },

    syncNowFromCloud() {
      if (!currentUser) return;
      return pullFromGoogleSheets({ silent: false });
    },

    saveStoreProfile(e) {
      e.preventDefault();
      if (!requirePerm(currentUser.akses.menus.includes('pengaturan'), 'Akses ditolak.')) return;
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
      if (!requirePerm(currentUser.akses.menus.includes('pengaturan'), 'Akses ditolak.')) return;
      const a = db.akunKas.find((x) => x.id === accId);
      if (!a) return;
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      setVal('acc-id', a.id);
      setVal('acc-nama', a.nama);
      setVal('acc-tipe', a.tipe);
      setVal('acc-saldo', Number(a.saldoAwal) || 0);
      showToast(`Mode edit akun kas "${a.nama}". Ubah data lalu klik Simpan.`, 'info');
    },

    submitAkunKas(e) {
      e.preventDefault();
      if (!requirePerm(currentUser.akses.menus.includes('pengaturan'), 'Akses ditolak.')) return;
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
        showToast(`Akun kas "${nama}" berhasil diperbarui!`, 'success');
      } else {
        const newId = 'ACC-' + nama.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) + '-' + String(db.akunKas.length + 1);
        db.akunKas.push({ id: newId, nama, tipe, saldoAwal, aktif: true });
        saveDatabase('CREATE_CASH_ACCOUNT', newId, `${nama} (${rp(saldoAwal)})`);
        showToast(`Akun kas baru "${nama}" ditambahkan!`, 'success');
      }
      renderApp();
    },

    exportBackupJson() {
      if (!requirePerm(currentUser.akses.menus.includes('pengaturan'), 'Akses ditolak.')) return;
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
      if (!requirePerm(currentUser.akses.menus.includes('pengaturan'), 'Akses ditolak.')) return;
      const file = event.target && event.target.files && event.target.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) {
        showToast('File backup terlalu besar (maksimal 10 MB).', 'error');
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const parsedRaw = JSON.parse(String(ev.target.result || '{}'));
          const parsed = stripProtoKeys(parsedRaw);
          if (!parsed || !Array.isArray(parsed.karyawan) || !Array.isArray(parsed.barang) || parsed.karyawan.length === 0) {
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

    confirmResetCleanProduction() {
      if (!requirePerm(currentUser.jabatan === 'Pemilik', 'Akses ditolak: Hanya Pemilik yang dapat mereset seluruh data ke nol!')) return;
      this.openConfirmModal(
        'Reset Data Transaksi & Dummy ke Nol?',
        `<p>Tindakan ini akan <b class="text-rose-400">MENGOSONGKAN</b> seluruh data Master Barang, Penjualan, Servis, Pembelian, Mutasi Stok, Pembayaran, Kas/Modal, Retur, dan mengubah Saldo Awal Akun Kas menjadi <b>Rp0</b> di aplikasi maupun di Google Spreadsheet.</p>
         <p class="text-emerald-300"><b>Aman:</b> Profil Toko, URL Spreadsheet, dan Akun Karyawan tetap dipertahankan.</p>`,
        async () => {
          db.barang = [];
          db.riwayatStok = [];
          db.pembelian = [];
          db.penjualan = [];
          db.servis = [];
          db.pembayaranTagihan = [];
          db.kasModal = [];
          db.returKoreksi = [];
          db.logAudit = [];
          db.akunKas.forEach((a) => { a.saldoAwal = 0; });
          posCart = [];
          posServices = [];
          posDiscount = 0;
          pbSelectedSku = '';
          editingBarangSku = '';
          saveDatabase('RESET_CLEAN_PRODUCTION', 'ALL_DATA', 'Bersihkan data dummy/transaksi ke nol siap produksi');
          showToast('Seluruh data berhasil dibersihkan ke nol & disinkronkan ke Google Spreadsheet!', 'success');
          renderApp();
        }
      );
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

    async printCurrentReceiptBluetooth(copies = 1) {
      const payload = copies === 2 ? (lastReceiptBleCopy2 || lastReceiptBlePayload) : lastReceiptBlePayload;
      if (!payload) {
        this.printSystemReceipt(copies);
        return;
      }
      if (!bluetoothCharacteristic || bluetoothStatus !== 'connected') {
        const connected = await this.connectBluetoothPrinter();
        if (!connected) {
          showToast('Membuka dialog Cetak Sistem sebagai metode cadangan...', 'info');
          this.printSystemReceipt(copies);
          return;
        }
      }
      if (lastReceiptMeta) {
        saveDatabase('PRINT_RECEIPT_BT', lastReceiptMeta.refNo, `${lastReceiptMeta.docType} (${copies}x Bluetooth)`);
      }
      await this.printViaBluetooth(payload);
    },

    printSystemReceipt(copies = 1) {
      const area = document.getElementById('thermal-print-area');
      const cleanup = () => {
        const el = document.getElementById('thermal-print-area');
        if (el) el.classList.remove('print-mode-2x');
      };
      if (area) {
        if (copies === 2) area.classList.add('print-mode-2x');
        else area.classList.remove('print-mode-2x');
      }
      if (lastReceiptMeta) {
        saveDatabase('PRINT_RECEIPT_SYS', lastReceiptMeta.refNo, `${lastReceiptMeta.docType} (${copies}x Sistem/PDF)`);
      }
      window.addEventListener('afterprint', cleanup, { once: true });
      window.print();
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

    // ========================================================================
    // EKSPOR LAPORAN RAPI SIAP CETAK (EXCEL 5-SHEET .XLS + CSV RAPI sep=;)
    // ========================================================================
    exportReportExcel() {
      if (!requirePerm(currentUser.akses.ekspor_laporan, 'Akses ditolak: Anda tidak memiliki izin mengekspor laporan.')) return;
      const m = calculateFinancialMetrics();
      const balances = getAccountBalances();
      const akses = currentUser.akses;
      const periodeLabel = `${filterDateStart || 'Awal'} s/d ${filterDateEnd || 'Sekarang'}`;

      const xmlEsc = (val) => {
        let s = String(val === null || val === undefined ? '' : val);
        const tr = s.trim();
        // Netralkan Formula Injection Excel pada teks user
        if (tr !== '' && tr !== '-' && (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d+(\.\d+)?$/.test(tr)))) {
          s = "'" + s;
        }
        return s
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&apos;');
      };

      const cellStr = (val, style = 'sData') => `<Cell ss:StyleID="${style}"><Data ss:Type="String">${xmlEsc(val)}</Data></Cell>`;
      const cellNum = (val, style = 'sCurr') => `<Cell ss:StyleID="${style}"><Data ss:Type="Number">${Number(val) || 0}</Data></Cell>`;
      const buildSheet = (name, colWidths, rowsXml) => {
        const colsXml = colWidths.map((w) => `<Column ss:AutoFitWidth="0" ss:Width="${w}"/>`).join('');
        return `<Worksheet ss:Name="${xmlEsc(name)}"><Table>${colsXml}${rowsXml.join('')}</Table></Worksheet>`;
      };
      const hdrRow = (headers) => `<Row ss:Height="24">${headers.map((h) => cellStr(h, 'sHeader')).join('')}</Row>`;
      const titleRow = (text, span) => `<Row ss:Height="26"><Cell ss:MergeAcross="${span - 1}" ss:StyleID="sTitle"><Data ss:Type="String">${xmlEsc(text)}</Data></Cell></Row>`;
      const subTitleRow = (text, span) => `<Row ss:Height="19"><Cell ss:MergeAcross="${span - 1}" ss:StyleID="sSubTitle"><Data ss:Type="String">${xmlEsc(text)}</Data></Cell></Row>`;
      const emptyRow = () => `<Row ss:Height="10"></Row>`;

      // 1. SHEET RINGKASAN KEUANGAN
      const ringRows = [
        titleRow(`LAPORAN KEUANGAN & LABA RUGI - ${db.config.namaToko}`, 3),
        subTitleRow(`Periode: ${periodeLabel} | Dicetak: ${nowStr()} | Petugas: ${currentUser.nama}`, 3),
        emptyRow(),
        hdrRow(['Kategori / Pos Keuangan', 'Keterangan', 'Nominal (Rp)']),
        `<Row>${cellStr('OMZET', 'sCat')}${cellStr('Penjualan Barang (POS)')}${cellNum(m.omzetPenjualanBarang)}</Row>`,
        `<Row>${cellStr('OMZET', 'sCat')}${cellStr('Jasa Pasang (POS Kasir)')}${cellNum(m.omzetJasaPenjualan)}</Row>`,
        `<Row>${cellStr('OMZET', 'sCat')}${cellStr('Pendapatan Jasa Servis')}${cellNum(m.omzetJasaServis)}</Row>`,
        `<Row>${cellStr('OMZET', 'sCat')}${cellStr('Spare Part Servis')}${cellNum(m.omzetSparepartServis)}</Row>`,
        `<Row>${cellStr('KOREKSI', 'sCat')}${cellStr('Retur Penjualan (Pengurang)')}${cellNum(-m.totalReturOmzet)}</Row>`,
        `<Row ss:Height="22">${cellStr('TOTAL', 'sTotalLabel')}${cellStr('Total Omzet Bersih', 'sTotalLabel')}${cellNum(m.omzetBersih, 'sTotalCurr')}</Row>`,
        emptyRow()
      ];
      if (akses.lihat_laba) {
        ringRows.push(
          `<Row>${cellStr('LABA RUGI', 'sCat')}${cellStr('Total HPP / Modal Barang Terjual')}${cellNum(-m.totalHpp)}</Row>`,
          `<Row ss:Height="21">${cellStr('LABA RUGI', 'sTotalLabel')}${cellStr('Laba Kotor', 'sTotalLabel')}${cellNum(m.labaKotor, 'sTotalCurr')}</Row>`,
          `<Row>${cellStr('BIAYA OPS', 'sCat')}${cellStr('Biaya Operasional Toko')}${cellNum(-m.biayaOperasional)}</Row>`,
          `<Row ss:Height="22">${cellStr('LABA BERSIH', 'sTotalLabel')}${cellStr('Laba Bersih Operasional', 'sTotalLabel')}${cellNum(m.labaBersihOperasional, 'sTotalCurr')}</Row>`,
          emptyRow()
        );
      }
      if (akses.lihat_modal) {
        ringRows.push(`<Row>${cellStr('ASET STOK', 'sCat')}${cellStr('Nilai Persediaan Barang di Rak')}${cellNum(m.nilaiPersediaan)}</Row>`);
      }
      ringRows.push(
        `<Row>${cellStr('MODAL', 'sCat')}${cellStr('Setoran Modal Pemilik')}${cellNum(m.modalDisetor)}</Row>`,
        `<Row>${cellStr('MODAL', 'sCat')}${cellStr('Penarikan Modal / Prive Pemilik')}${cellNum(m.modalDitarik)}</Row>`,
        `<Row>${cellStr('TAGIHAN', 'sCat')}${cellStr('Total Piutang Pelanggan (Belum Lunas)')}${cellNum(m.totalPiutang)}</Row>`,
        `<Row>${cellStr('TAGIHAN', 'sCat')}${cellStr('Total Utang Pemasok (Belum Lunas)')}${cellNum(m.totalUtang)}</Row>`,
        emptyRow(),
        hdrRow(['ID Akun Kas', 'Nama Akun Kas / Bank', 'Saldo Akhir (Rp)']),
        ...balances.map((a) => `<Row>${cellStr(a.id, 'sCenter')}${cellStr(`${a.nama} (${a.tipe})`)}${cellNum(a.saldoAkhir)}</Row>`),
        `<Row ss:Height="22">${cellStr('TOTAL KAS', 'sTotalLabel')}${cellStr('Total Seluruh Saldo Kas & Bank', 'sTotalLabel')}${cellNum(balances.reduce((s, a) => s + a.saldoAkhir, 0), 'sTotalCurr')}</Row>`
      );

      // 2. SHEET PENJUALAN
      const salesList = db.penjualan.filter((p) => (akses.semua_transaksi || p.petugas === currentUser.username) && isInDateFilter(p.tanggalJam));
      const salesHeaders = ['No Transaksi', 'Tanggal & Jam', 'Dokumen', 'Pelanggan', 'Kontak', 'Rincian Barang', 'Rincian Jasa Pasang', 'Subtotal Barang', 'Total Jasa', 'Diskon', 'Total Akhir'];
      const salesWidths = [85, 105, 65, 115, 95, 190, 150, 95, 90, 80, 100];
      if (akses.lihat_laba) {
        salesHeaders.push('HPP / Modal', 'Laba Kotor');
        salesWidths.push(95, 95);
      }
      salesHeaders.push('Metode', 'Uang Diterima', 'Kembalian', 'Terbayar', 'Sisa Piutang', 'Status Bayar', 'Petugas', 'Catatan');
      salesWidths.push(70, 95, 85, 95, 95, 85, 75, 140);

      const salesRows = [
        titleRow(`DATA TRANSAKSI PENJUALAN (+ JASA PASANG) - ${db.config.namaToko}`, salesHeaders.length),
        subTitleRow(`Periode: ${periodeLabel} | Jumlah Transaksi: ${salesList.length}`, salesHeaders.length),
        emptyRow(),
        hdrRow(salesHeaders),
        ...salesList.map((p) => {
          const items = Array.isArray(p.items) ? p.items : [];
          const jasa = Array.isArray(p.jasaItems) ? p.jasaItems : [];
          const subBrg = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.hargaJual) || 0), 0);
          const brgTxt = items.map((i) => `${i.nama} (${i.qty}x ${rp(i.hargaJual)})`).join('; ') || '-';
          const jasaTxt = jasa.map((j) => `${j.nama} (${rp(j.biaya)})`).join('; ') || '-';
          const cells = [
            cellStr(p.no, 'sCenter'), cellStr(p.tanggalJam, 'sCenter'), cellStr(p.statusDokumen, 'sCenter'),
            cellStr(p.pelanggan), cellStr(p.kontak || '-'), cellStr(brgTxt), cellStr(jasaTxt),
            cellNum(subBrg), cellNum(p.totalJasa || 0), cellNum(p.diskon || 0), cellNum(p.totalAkhir)
          ];
          if (akses.lihat_laba) {
            cells.push(cellNum(p.totalModalHistoris || 0), cellNum(p.labaKotor || 0));
          }
          cells.push(
            cellStr(p.metodeBayar, 'sCenter'), cellNum(p.uangDiterima || 0), cellNum(p.kembalian || 0),
            cellNum(p.jumlahTerbayar || 0), cellNum(p.sisaPiutang || 0), cellStr(p.statusBayar, 'sCenter'),
            cellStr(p.petugas, 'sCenter'), cellStr(p.catatan || '-')
          );
          return `<Row>${cells.join('')}</Row>`;
        })
      ];

      // 3. SHEET SERVIS
      const srvList = db.servis.filter((s) => (akses.semua_transaksi || s.teknisi === currentUser.username || s.petugasTerima === currentUser.username) && isInDateFilter(s.tanggalTerima));
      const srvHeaders = ['No Servis', 'Tgl Terima', 'Tgl Selesai', 'Pelanggan', 'Kontak', 'Perangkat & Model', 'Jenis Servis', 'Status Kerja', 'Rincian Sparepart', 'Total Part', 'Rincian Jasa', 'Biaya Jasa', 'Diskon', 'Total Final', 'Terbayar/DP', 'Sisa Tagihan', 'Status Bayar', 'Teknisi'];
      const srvWidths = [80, 100, 100, 115, 95, 130, 120, 80, 175, 90, 150, 90, 80, 95, 95, 95, 85, 75];
      const srvRows = [
        titleRow(`DATA SERVIS PERANGKAT - ${db.config.namaToko}`, srvHeaders.length),
        subTitleRow(`Periode: ${periodeLabel} | Jumlah Unit Servis: ${srvList.length}`, srvHeaders.length),
        emptyRow(),
        hdrRow(srvHeaders),
        ...srvList.map((s) => {
          const partTxt = (s.spareparts || []).map((sp) => `${sp.nama} (${sp.qty}x ${rp(sp.hargaJual)})`).join('; ') || '-';
          const jasaTxt = (s.jasaItems && s.jasaItems.length ? s.jasaItems.map((j) => `${j.nama} (${rp(j.biaya)})`).join('; ') : (s.namaJasa || '-'));
          return `<Row>${[
            cellStr(s.no, 'sCenter'), cellStr(s.tanggalTerima, 'sCenter'), cellStr(s.tanggalSelesai || '-', 'sCenter'),
            cellStr(s.pelanggan), cellStr(s.kontak || '-'), cellStr(`${s.perangkat} - ${s.merekModel}`),
            cellStr(s.jenisServis), cellStr(s.statusPengerjaan, 'sCenter'), cellStr(partTxt),
            cellNum(s.totalSparepart || 0), cellStr(jasaTxt), cellNum(s.biayaJasa || 0),
            cellNum(s.diskon || 0), cellNum(s.totalBiayaFinal || 0), cellNum(s.totalTerbayar || 0),
            cellNum(s.sisaTagihan || 0), cellStr(s.statusBayar, 'sCenter'), cellStr(s.teknisi || '-', 'sCenter')
          ].join('')}</Row>`;
        })
      ];

      // 4. SHEET STOK BARANG
      const stokHeaders = ['Kode SKU', 'Barcode', 'Nama Barang', 'Kategori', 'Satuan'];
      const stokWidths = [85, 90, 195, 95, 55];
      if (akses.lihat_modal) { stokHeaders.push('Harga Modal'); stokWidths.push(95); }
      stokHeaders.push('Harga Jual', 'Stok Awal', 'Masuk', 'Keluar', 'Stok Akhir', 'Stok Min');
      stokWidths.push(95, 65, 60, 60, 70, 65);
      if (akses.lihat_modal) { stokHeaders.push('Nilai Persediaan'); stokWidths.push(110); }
      stokHeaders.push('Pemasok', 'Status');
      stokWidths.push(115, 65);

      const stokRows = [
        titleRow(`DAFTAR PERSEDIAAN & STOK BARANG - ${db.config.namaToko}`, stokHeaders.length),
        subTitleRow(`Dicetak: ${nowStr()} | Total SKU: ${db.barang.length}`, stokHeaders.length),
        emptyRow(),
        hdrRow(stokHeaders),
        ...db.barang.map((b) => {
          const akhir = getStokAkhir(b);
          const cells = [cellStr(b.sku, 'sCenter'), cellStr(b.barcode || '-', 'sCenter'), cellStr(b.nama), cellStr(b.kategori), cellStr(b.satuan, 'sCenter')];
          if (akses.lihat_modal) cells.push(cellNum(b.hargaModal || 0));
          cells.push(
            cellNum(b.hargaJual || 0),
            cellNum(b.stokAwal || 0, 'sInt'), cellNum(b.masuk || 0, 'sInt'),
            cellNum(b.keluar || 0, 'sInt'), cellNum(akhir, 'sInt'), cellNum(b.stokMinimum || 0, 'sInt')
          );
          if (akses.lihat_modal) cells.push(cellNum(akhir * (Number(b.hargaModal) || 0)));
          cells.push(cellStr(b.pemasok || '-'), cellStr(b.aktif ? 'Aktif' : 'Nonaktif', 'sCenter'));
          return `<Row>${cells.join('')}</Row>`;
        })
      ];

      // 5. SHEET ARUS KAS & MODAL
      const kasList = db.kasModal.filter((k) => isInDateFilter(k.tanggalJam));
      const kasHeaders = ['ID Kas', 'Waktu', 'Jenis Arus', 'Kategori', 'Akun Asal', 'Akun Tujuan', 'Nominal (Rp)', 'No Referensi', 'Keterangan', 'Petugas'];
      const kasWidths = [90, 105, 70, 145, 95, 95, 105, 85, 200, 75];
      const kasRows = [
        titleRow(`BUKU ARUS KAS & MODAL - ${db.config.namaToko}`, kasHeaders.length),
        subTitleRow(`Periode: ${periodeLabel} | Jumlah Mutasi: ${kasList.length}`, kasHeaders.length),
        emptyRow(),
        hdrRow(kasHeaders),
        ...kasList.map((k) => `<Row>${[
          cellStr(k.id, 'sCenter'), cellStr(k.tanggalJam, 'sCenter'), cellStr(k.jenis, 'sCenter'),
          cellStr(k.kategori), cellStr(k.akunAsal || '-', 'sCenter'), cellStr(k.akunTujuan || '-', 'sCenter'),
          cellNum(k.nominal || 0), cellStr(k.noRef || '-', 'sCenter'), cellStr(k.keterangan || '-'), cellStr(k.petugas || '-', 'sCenter')
        ].join('')}</Row>`)
      ];

      const workbookXml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="10" ss:Color="#0F172A"/>
  </Style>
  <Style ss:ID="sTitle">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="13" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#0F172A" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="sSubTitle">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="9" ss:Italic="1" ss:Color="#334155"/>
   <Interior ss:Color="#F1F5F9" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="sHeader">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
   <Font ss:FontName="Calibri" ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1E293B" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#F59E0B"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#334155"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#334155"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#334155"/>
   </Borders>
  </Style>
  <Style ss:ID="sData">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:WrapText="1"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="sCenter">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="sCat">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="9" ss:Bold="1" ss:Color="#0369A1"/>
   <Interior ss:Color="#F0F9FF" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="sCurr">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <NumberFormat ss:Format="&quot;Rp&quot;#,##0;&quot;-Rp&quot;#,##0;&quot;Rp0&quot;"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="sInt">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <NumberFormat ss:Format="#,##0"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="sTotalLabel">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="10" ss:Bold="1" ss:Color="#0F172A"/>
   <Interior ss:Color="#FEF3C7" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#F59E0B"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#F59E0B"/>
   </Borders>
  </Style>
  <Style ss:ID="sTotalCurr">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="10" ss:Bold="1" ss:Color="#0F172A"/>
   <Interior ss:Color="#FEF3C7" ss:Pattern="Solid"/>
   <NumberFormat ss:Format="&quot;Rp&quot;#,##0;&quot;-Rp&quot;#,##0;&quot;Rp0&quot;"/>
   <Borders>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#F59E0B"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#F59E0B"/>
   </Borders>
  </Style>
 </Styles>
 ${buildSheet('Ringkasan_Keuangan', [110, 260, 130], ringRows)}
 ${buildSheet('Penjualan', salesWidths, salesRows)}
 ${buildSheet('Servis', srvWidths, srvRows)}
 ${buildSheet('Stok_Barang', stokWidths, stokRows)}
 ${buildSheet('Arus_Kas_Modal', kasWidths, kasRows)}
</Workbook>`;

      const blob = new Blob([workbookXml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Laporan_Rapi_AziCell_${todayStr()}.xls`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      saveDatabase('EXPORT_EXCEL', '5_SHEETS', `Periode ${periodeLabel}`);
      showToast('Laporan Excel Rapi (5 Sheet siap cetak) berhasil diunduh!', 'success');
    },

    exportReportCsv(scope = 'lengkap') {
      if (!requirePerm(currentUser.akses.ekspor_laporan, 'Akses ditolak: Anda tidak memiliki izin mengekspor laporan.')) return;
      const m = calculateFinancialMetrics();
      const balances = getAccountBalances();
      const akses = currentUser.akses;
      const periodeLabel = `${filterDateStart || 'Awal'} s/d ${filterDateEnd || 'Sekarang'}`;

      // Sanitasi CSV: bersih ASCII agar directive sep=; dibaca 100% akurat oleh Excel Indonesia/EN + anti Formula Injection!
      const csvCell = (val) => {
        if (typeof val === 'number' && !isNaN(val)) return String(val);
        let s = String(val === null || val === undefined ? '' : val)
          .replace(/\r?\n/g, ' ')
          .replace(/[\u2013\u2014]/g, '-')
          .replace(/\u2022/g, '|')
          .replace(/[^\x20-\x7E]/g, ' ');
        const tr = s.trim();
        if (tr !== '' && tr !== '-' && (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d+(\.\d+)?$/.test(tr)))) {
          s = "'" + s;
        }
        return `"${s.replace(/"/g, '""')}"`;
      };

      let rows = [];
      let fileSuffix = 'Ringkasan';

      if (scope === 'penjualan') {
        fileSuffix = 'Penjualan';
        const headers = ['No Transaksi', 'Tanggal Jam', 'Status Dokumen', 'Pelanggan', 'Kontak', 'Rincian Barang', 'Rincian Jasa Pasang', 'Subtotal Barang (Rp)', 'Total Jasa (Rp)', 'Diskon (Rp)', 'Total Akhir (Rp)'];
        if (akses.lihat_laba) headers.push('HPP Modal (Rp)', 'Laba Kotor (Rp)');
        headers.push('Metode Bayar', 'Uang Diterima (Rp)', 'Kembalian (Rp)', 'Terbayar (Rp)', 'Sisa Piutang (Rp)', 'Status Bayar', 'Petugas', 'Catatan');
        rows.push(headers);
        db.penjualan
          .filter((p) => (akses.semua_transaksi || p.petugas === currentUser.username) && isInDateFilter(p.tanggalJam))
          .forEach((p) => {
            const items = Array.isArray(p.items) ? p.items : [];
            const jasa = Array.isArray(p.jasaItems) ? p.jasaItems : [];
            const subBrg = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.hargaJual) || 0), 0);
            const r = [
              p.no, p.tanggalJam, p.statusDokumen, p.pelanggan, p.kontak || '-',
              items.map((i) => `${i.nama} (${i.qty}x ${rp(i.hargaJual)})`).join(' | ') || '-',
              jasa.map((j) => `${j.nama} (${rp(j.biaya)})`).join(' | ') || '-',
              subBrg, Number(p.totalJasa) || 0, Number(p.diskon) || 0, Number(p.totalAkhir) || 0
            ];
            if (akses.lihat_laba) r.push(Number(p.totalModalHistoris) || 0, Number(p.labaKotor) || 0);
            r.push(p.metodeBayar, Number(p.uangDiterima) || 0, Number(p.kembalian) || 0, Number(p.jumlahTerbayar) || 0, Number(p.sisaPiutang) || 0, p.statusBayar, p.petugas, p.catatan || '-');
            rows.push(r);
          });
      } else if (scope === 'servis') {
        fileSuffix = 'Servis';
        rows.push(['No Servis', 'Tgl Terima', 'Tgl Selesai', 'Pelanggan', 'Kontak', 'Perangkat Model', 'Jenis Servis', 'Status Kerja', 'Rincian Sparepart', 'Total Part (Rp)', 'Rincian Jasa', 'Biaya Jasa (Rp)', 'Diskon (Rp)', 'Total Final (Rp)', 'Terbayar DP (Rp)', 'Sisa Tagihan (Rp)', 'Status Bayar', 'Teknisi']);
        db.servis
          .filter((s) => (akses.semua_transaksi || s.teknisi === currentUser.username || s.petugasTerima === currentUser.username) && isInDateFilter(s.tanggalTerima))
          .forEach((s) => {
            const partTxt = (s.spareparts || []).map((sp) => `${sp.nama} (${sp.qty}x ${rp(sp.hargaJual)})`).join(' | ') || '-';
            const jasaTxt = (s.jasaItems && s.jasaItems.length ? s.jasaItems.map((j) => `${j.nama} (${rp(j.biaya)})`).join(' | ') : (s.namaJasa || '-'));
            rows.push([
              s.no, s.tanggalTerima, s.tanggalSelesai || '-', s.pelanggan, s.kontak || '-',
              `${s.perangkat} - ${s.merekModel}`, s.jenisServis, s.statusPengerjaan, partTxt,
              Number(s.totalSparepart) || 0, jasaTxt, Number(s.biayaJasa) || 0, Number(s.diskon) || 0,
              Number(s.totalBiayaFinal) || 0, Number(s.totalTerbayar) || 0, Number(s.sisaTagihan) || 0,
              s.statusBayar, s.teknisi || '-'
            ]);
          });
      } else if (scope === 'stok') {
        fileSuffix = 'Stok_Barang';
        const headers = ['Kode SKU', 'Barcode', 'Nama Barang', 'Kategori', 'Satuan'];
        if (akses.lihat_modal) headers.push('Harga Modal (Rp)');
        headers.push('Harga Jual (Rp)', 'Stok Awal', 'Masuk', 'Keluar', 'Stok Akhir', 'Stok Min');
        if (akses.lihat_modal) headers.push('Nilai Persediaan (Rp)');
        headers.push('Pemasok', 'Status');
        rows.push(headers);
        db.barang.forEach((b) => {
          const akhir = getStokAkhir(b);
          const r = [b.sku, b.barcode || '-', b.nama, b.kategori, b.satuan];
          if (akses.lihat_modal) r.push(Number(b.hargaModal) || 0);
          r.push(Number(b.hargaJual) || 0, Number(b.stokAwal) || 0, Number(b.masuk) || 0, Number(b.keluar) || 0, akhir, Number(b.stokMinimum) || 0);
          if (akses.lihat_modal) r.push(akhir * (Number(b.hargaModal) || 0));
          r.push(b.pemasok || '-', b.aktif ? 'Aktif' : 'Nonaktif');
          rows.push(r);
        });
      } else if (scope === 'kas') {
        fileSuffix = 'Arus_Kas';
        rows.push(['ID Kas', 'Waktu', 'Jenis Arus', 'Kategori', 'Akun Asal', 'Akun Tujuan', 'Nominal (Rp)', 'No Referensi', 'Keterangan', 'Petugas']);
        db.kasModal
          .filter((k) => isInDateFilter(k.tanggalJam))
          .forEach((k) => {
            rows.push([k.id, k.tanggalJam, k.jenis, k.kategori, k.akunAsal || '-', k.akunTujuan || '-', Number(k.nominal) || 0, k.noRef || '-', k.keterangan || '-', k.petugas || '-']);
          });
      } else {
        fileSuffix = 'Ringkasan_Keuangan';
        rows = [
          ['Kategori', 'Pos Keuangan', 'Nominal (Rp)', 'Format Rupiah'],
          ['INFO', `Toko: ${db.config.namaToko} | Periode: ${periodeLabel}`, 0, `Dicetak: ${nowStr()}`],
          ['OMZET', 'Penjualan Barang (POS)', m.omzetPenjualanBarang, rp(m.omzetPenjualanBarang)],
          ['OMZET', 'Jasa Pasang (POS Kasir)', m.omzetJasaPenjualan, rp(m.omzetJasaPenjualan)],
          ['OMZET', 'Pendapatan Jasa Servis', m.omzetJasaServis, rp(m.omzetJasaServis)],
          ['OMZET', 'Spare Part Servis', m.omzetSparepartServis, rp(m.omzetSparepartServis)],
          ['KOREKSI', 'Retur Penjualan', -m.totalReturOmzet, '-' + rp(m.totalReturOmzet)],
          ['TOTAL', 'Total Omzet Bersih', m.omzetBersih, rp(m.omzetBersih)]
        ];
        if (akses.lihat_laba) {
          rows.push(
            ['LABA RUGI', 'Total HPP / Modal Terjual', -m.totalHpp, '-' + rp(m.totalHpp)],
            ['LABA RUGI', 'Laba Kotor', m.labaKotor, rp(m.labaKotor)],
            ['BIAYA OPS', 'Biaya Operasional Toko', -m.biayaOperasional, '-' + rp(m.biayaOperasional)],
            ['TOTAL', 'Laba Bersih Operasional', m.labaBersihOperasional, rp(m.labaBersihOperasional)]
          );
        }
        if (akses.lihat_modal) {
          rows.push(['ASET STOK', 'Nilai Persediaan Barang', m.nilaiPersediaan, rp(m.nilaiPersediaan)]);
        }
        rows.push(
          ['MODAL', 'Setoran Modal Pemilik', m.modalDisetor, rp(m.modalDisetor)],
          ['MODAL', 'Penarikan Modal Pemilik', m.modalDitarik, rp(m.modalDitarik)],
          ['TAGIHAN', 'Total Piutang Pelanggan', m.totalPiutang, rp(m.totalPiutang)],
          ['TAGIHAN', 'Total Utang Pemasok', m.totalUtang, rp(m.totalUtang)],
          ...balances.map((a) => ['SALDO KAS', `${a.nama} (${a.tipe})`, a.saldoAkhir, rp(a.saldoAkhir)])
        );
      }

      // Gunakan directive sep=; tanpa BOM agar Excel langsung memisahkan kolom 100% rapi tanpa edit!
      const csv = 'sep=;\r\n' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `AziCell_${fileSuffix}_${todayStr()}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      saveDatabase('EXPORT_CSV', fileSuffix, `Periode ${periodeLabel}`);
      showToast(`CSV ${fileSuffix.replace(/_/g, ' ')} rapi siap buka di Excel berhasil diunduh!`, 'success');
    }
  };

  function renderApp() {
    const root = document.getElementById('app-root');
    if (!root) return;
    root.innerHTML = currentUser ? renderMainLayout() : renderLoginView();
  }

  // Tutup dropdown auto-search saat klik di luar kotak pencarian
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (!t.closest('#global-quick-search') && !t.closest('#global-search-dropdown')) {
      const box = document.getElementById('global-search-dropdown');
      if (box) box.classList.add('hidden');
    }
    if (!t.closest('#pb-item-search') && !t.closest('#pb-item-suggest')) {
      const box = document.getElementById('pb-item-suggest');
      if (box) box.classList.add('hidden');
    }
    if (!t.closest('#ret-noref') && !t.closest('#ret-ref-suggest')) {
      const box = document.getElementById('ret-ref-suggest');
      if (box) box.classList.add('hidden');
    }
    if (!t.closest('#brg-sku') && !t.closest('#brg-barcode') && !t.closest('#brg-sku-suggest')) {
      const box = document.getElementById('brg-sku-suggest');
      if (box) box.classList.add('hidden');
    }
  });

  // Jalankan aplikasi & pengecekan Auto-Update Service Worker
  initServiceWorkerAndAutoUpdate();
  renderApp();

  // Tarik data terbaru dari Google Spreadsheet setiap kali aplikasi dibuka / di-refresh (Google Sheet = sumber data utama)
  if (db.config.gasWebAppUrl) {
    initialCloudPullPromise = pullFromGoogleSheets({ silent: true });
  }
})();