/**
 * ================================================================
 *  VSK SISTEM ABSENSI — Google Apps Script Backend
 *  PT Varian Sumber Karya · Sidoarjo, Jawa Timur
 * ================================================================
 *
 *  PANDUAN SETUP (baca sebelum deploy):
 *
 *  1. Buat Google Spreadsheet baru (beri nama "VSK Absensi")
 *     → Salin Spreadsheet ID dari URL, tempel ke CONFIG.SPREADSHEET_ID
 *
 *  2. Buka Apps Script Editor (Extensions → Apps Script)
 *     → Salin seluruh kode ini ke editor
 *
 *  3. Deploy sebagai Web App:
 *     → Deploy → New deployment → Web App
 *     → Execute as: Me
 *     → Who has access: Anyone   ← PENTING: harus "Anyone"
 *     → Deploy → Authorize → Salin URL
 *
 *  4. Tempel URL ke index.html pada konstanta APPS_SCRIPT_URL
 *
 *  5. Setiap kali ada perubahan kode: Deploy → Manage deployments
 *     → Edit → New version → Deploy (jangan buat deployment baru)
 *
 * ================================================================
 */

// ---------------------------------------------------------------
//  KONFIGURASI
// ---------------------------------------------------------------
const CONFIG = {
  SPREADSHEET_ID       : 'GANTI_DENGAN_SPREADSHEET_ID_KAMU',
  SHEET_NAME           : 'Absensi',
  DRIVE_ROOT_FOLDER    : 'VSK Absensi Foto',
  FACTORY_LAT          : -7.4967097,
  FACTORY_LNG          : 112.6289471,
  RADIUS_METERS        : 100,
  LATE_HOUR            : 8,   // WIB — masuk setelah jam 08:xx dianggap terlambat
  LATE_MINUTE          : 5,   // toleransi 5 menit: 08:05 masih on-time
  TIMEZONE             : 'Asia/Jakarta'
};

// ---------------------------------------------------------------
//  ENTRY POINT — HTTP POST
// ---------------------------------------------------------------
function doPost(e) {
  try {
    // Parse body
    const raw = (e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const d   = JSON.parse(raw);

    // --- Validasi dasar ---
    if (!d.nama || !String(d.nama).trim()) throw new Error('Nama staff wajib diisi.');
    if (!d.jenis) throw new Error('Jenis absensi tidak boleh kosong.');

    const VALID_JENIS = ['Masuk', 'Pulang', 'Izin'];
    if (!VALID_JENIS.includes(d.jenis)) throw new Error('Jenis tidak dikenal: ' + d.jenis);

    if ((d.jenis === 'Masuk' || d.jenis === 'Pulang') && !d.foto) {
      throw new Error('Foto selfie wajib untuk absensi ' + d.jenis + '.');
    }
    if (d.jenis === 'Izin' && (!d.keterangan || !String(d.keterangan).trim())) {
      throw new Error('Keterangan wajib diisi untuk absensi Izin.');
    }

    // --- Timestamp server (WIB) ---
    const now          = new Date();
    const timestampStr = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    const tanggalStr   = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd');
    const jamStr       = Utilities.formatDate(now, CONFIG.TIMEZONE, 'HH:mm:ss');

    // --- GPS / Haversine ---
    const lat = (d.lat !== null && d.lat !== '' && d.lat !== undefined) ? parseFloat(d.lat) : null;
    const lng = (d.lng !== null && d.lng !== '' && d.lng !== undefined) ? parseFloat(d.lng) : null;

    let jarakMeter  = null;
    let dalamRadius = null;

    if (lat !== null && lng !== null && !isNaN(lat) && !isNaN(lng)) {
      jarakMeter  = Math.round(haversineDistance(lat, lng, CONFIG.FACTORY_LAT, CONFIG.FACTORY_LNG));
      dalamRadius = (jarakMeter <= CONFIG.RADIUS_METERS);
    }

    // --- Tentukan Status ---
    let status = d.jenis;

    if (d.jenis === 'Masuk') {
      const h = parseInt(Utilities.formatDate(now, CONFIG.TIMEZONE, 'H'), 10);
      const m = parseInt(Utilities.formatDate(now, CONFIG.TIMEZONE, 'm'), 10);
      const terlambat = (h > CONFIG.LATE_HOUR) ||
                        (h === CONFIG.LATE_HOUR && m > CONFIG.LATE_MINUTE);
      status = terlambat ? 'Masuk (Telat)' : 'Masuk';
      if (dalamRadius === false) status += ' [TIDAK VALID]';

    } else if (d.jenis === 'Pulang') {
      status = 'Pulang';
      if (dalamRadius === false) status += ' [TIDAK VALID]';
    }
    // Izin: tidak ada validasi radius (staff sedang tidak di tempat)

    // --- Upload foto ke Drive ---
    let fotoLink = '';
    if (d.foto && String(d.foto).length > 100) {
      try {
        fotoLink = uploadFoto(d.foto, String(d.nama).trim(), timestampStr);
      } catch (uploadErr) {
        Logger.log('[VSK Absensi] Upload foto gagal: ' + uploadErr.message);
        fotoLink = 'UPLOAD_GAGAL';
      }
    }

    // --- Tulis ke Sheets ---
    const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    let   sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_NAME);

    if (sheet.getLastRow() === 0) initHeader(sheet);

    const row = [
      timestampStr,
      tanggalStr,
      jamStr,
      String(d.nama).trim(),
      d.jenis,
      lat  !== null ? lat  : '',
      lng  !== null ? lng  : '',
      jarakMeter  !== null ? jarakMeter  : '',
      dalamRadius !== null ? (dalamRadius ? 'YA' : 'TIDAK') : 'N/A',
      status,
      d.keterangan ? String(d.keterangan).trim() : '',
      fotoLink
    ];
    sheet.appendRow(row);

    // Warna baris berdasarkan status
    const lastRow = sheet.getLastRow();
    if (status.includes('TIDAK VALID')) {
      sheet.getRange(lastRow, 1, 1, 12).setBackground('#fdf0f0');
    } else if (status.includes('Telat')) {
      sheet.getRange(lastRow, 1, 1, 12).setBackground('#fdf4e7');
    } else if (status === 'Izin') {
      sheet.getRange(lastRow, 1, 1, 12).setBackground('#f5f5ff');
    }

    return ok({ timestamp: timestampStr, status, jarak: jarakMeter, dalamRadius });

  } catch (err) {
    Logger.log('[VSK Absensi] ERROR: ' + err.message);
    return fail(err.message);
  }
}

// ---------------------------------------------------------------
//  HAVERSINE FORMULA
// ---------------------------------------------------------------
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R   = 6371000; // radius Bumi dalam meter
  const rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------
//  UPLOAD FOTO → GOOGLE DRIVE
//  Struktur folder: VSK Absensi Foto / YYYY-MM / NAMA_TIMESTAMP.jpg
// ---------------------------------------------------------------
function uploadFoto(base64DataUrl, namaStaff, timestamp) {
  const match = base64DataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Format base64 foto tidak valid.');

  const mimeType = match[1];
  const base64   = match[2];
  const bytes    = Utilities.base64Decode(base64);
  const blob     = Utilities.newBlob(bytes, mimeType);

  // Sanitize nama file
  const safeName = namaStaff.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').substring(0, 30);
  const safeTime = timestamp.replace(/[: ]/g, '-');
  blob.setName(safeName + '_' + safeTime + '.jpg');

  // Root folder
  const rootIter   = DriveApp.getFoldersByName(CONFIG.DRIVE_ROOT_FOLDER);
  const rootFolder = rootIter.hasNext()
    ? rootIter.next()
    : DriveApp.createFolder(CONFIG.DRIVE_ROOT_FOLDER);

  // Subfolder bulan: YYYY-MM
  const monthStr   = timestamp.substring(0, 7);
  const monthIter  = rootFolder.getFoldersByName(monthStr);
  const monthFolder = monthIter.hasNext()
    ? monthIter.next()
    : rootFolder.createFolder(monthStr);

  const file = monthFolder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

// ---------------------------------------------------------------
//  INIT HEADER SHEET
// ---------------------------------------------------------------
function initHeader(sheet) {
  const headers = [
    'Timestamp Server', 'Tanggal', 'Jam', 'Nama Staff', 'Jenis',
    'GPS Lat', 'GPS Lng', 'Jarak (m)', 'Dalam Radius', 'Status',
    'Keterangan', 'Link Foto'
  ];
  sheet.appendRow(headers);

  const rng = sheet.getRange(1, 1, 1, headers.length);
  rng.setFontWeight('bold');
  rng.setBackground('#3d6b47');
  rng.setFontColor('#ffffff');
  rng.setFontFamily('Arial');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}

// ---------------------------------------------------------------
//  RESPONSE HELPERS
// ---------------------------------------------------------------
function ok(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: true, ...data }))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail(message) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: false, error: message }))
    .setMimeType(ContentService.MimeType.JSON);
}
