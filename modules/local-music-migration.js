// 本地歌曲迁移：扫描音乐库中仍保存在本地的歌曲，上传 Catbox 后替换为 URL。
(function () {
  'use strict';

  function formatMB(bytes) {
    return (bytes / 1024 / 1024).toFixed(2);
  }

  function isLocalSong(song) {
    if (!song || typeof song !== 'object') return false;
    if (typeof song.src === 'string' && /files\.catbox\.moe/i.test(song.src)) return false;
    if (song.isLocal) return true;
    if (song.src instanceof ArrayBuffer || ArrayBuffer.isView(song.src) || song.src instanceof Blob) return true;
    return typeof song.src === 'string' && /^(data:audio\/|blob:)/i.test(song.src);
  }

  function songSize(song) {
    if (song.src instanceof ArrayBuffer) return song.src.byteLength;
    if (ArrayBuffer.isView(song.src)) return song.src.byteLength;
    if (song.src instanceof Blob) return song.src.size;
    if (typeof song.src === 'string' && song.src.startsWith('data:')) {
      const comma = song.src.indexOf(',');
      return comma >= 0 ? Math.floor((song.src.length - comma - 1) * 0.75) : song.src.length;
    }
    return 0;
  }

  async function songToBlob(song) {
    const type = song.fileType || 'audio/mpeg';
    if (song.src instanceof Blob) return song.src;
    if (song.src instanceof ArrayBuffer) return new Blob([song.src], { type });
    if (ArrayBuffer.isView(song.src)) return new Blob([song.src.buffer], { type });
    if (typeof song.src === 'string' && (song.src.startsWith('data:') || song.src.startsWith('blob:'))) {
      const response = await fetch(song.src);
      if (!response.ok) throw new Error('读取本地歌曲失败');
      return response.blob();
    }
    throw new Error('不支持的本地歌曲格式');
  }

  function ensureModal() {
    let modal = document.getElementById('local-music-migration-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'local-music-migration-modal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:560px;">
        <div class="modal-header">
          <span>扫描并上传本地歌曲为 URL</span>
          <span class="close" id="close-local-music-migration" style="cursor:pointer; float:right; font-size:28px; font-weight:bold;">&times;</span>
        </div>
        <div class="modal-body" style="overflow:auto;">
          <div style="font-size:12px;color:#666;line-height:1.7;background:#fff7ed;border-left:3px solid #f59e0b;padding:10px 12px;border-radius:6px;margin-bottom:12px;">
            扫描音乐库中仍保存在本地的歌曲，上传 Catbox 后把歌曲地址替换为 URL。Catbox 是公共文件托管，请确认歌曲可以上传。
          </div>
          <div id="local-music-migration-summary" style="font-size:13px;color:#333;margin-bottom:10px;">正在扫描...</div>
          <div id="local-music-migration-list" style="max-height:220px;overflow:auto;font-size:12px;color:#555;line-height:1.8;"></div>
          <div id="local-music-migration-progress" style="display:none;margin-top:12px;font-size:12px;color:#555;"></div>
          <div id="local-music-migration-failures" style="display:none;margin-top:10px;font-size:12px;color:#b91c1c;white-space:pre-wrap;max-height:120px;overflow:auto;"></div>
        </div>
        <div class="modal-footer">
          <button id="cancel-local-music-migration" class="form-button form-button-secondary" style="margin-right:10px;">取消</button>
          <button id="start-local-music-migration" class="form-button" disabled>开始上传</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#close-local-music-migration')?.addEventListener('click', close);
    modal.querySelector('#cancel-local-music-migration')?.addEventListener('click', close);
    return modal;
  }

  function close() {
    document.getElementById('local-music-migration-modal')?.classList.remove('visible');
  }

  function renderScan(modal, record, localSongs) {
    const summary = modal.querySelector('#local-music-migration-summary');
    const list = modal.querySelector('#local-music-migration-list');
    const startBtn = modal.querySelector('#start-local-music-migration');
    const totalBytes = localSongs.reduce((sum, item) => sum + songSize(item.song), 0);
    summary.textContent = localSongs.length
      ? `找到 ${localSongs.length} 首本地歌曲，约 ${formatMB(totalBytes)} MB。`
      : '没有找到需要上传的本地歌曲。';
    list.innerHTML = localSongs.length
      ? localSongs.map(item => `<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px solid #f3f3f3;">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.song.name || '未命名歌曲')}</span>
          <span style="white-space:nowrap;color:#999;">${formatMB(songSize(item.song))} MB</span>
        </div>`).join('')
      : '';
    startBtn.disabled = localSongs.length === 0;
    startBtn.textContent = localSongs.length ? '开始上传' : '没有可上传歌曲';
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  async function runUpload(modal, record, localSongs) {
    const startBtn = modal.querySelector('#start-local-music-migration');
    const progress = modal.querySelector('#local-music-migration-progress');
    const failures = modal.querySelector('#local-music-migration-failures');
    if (typeof state === 'undefined' || !state.apiConfig?.catboxEnable || !state.apiConfig?.catboxUserHash) {
      alert('请先开启 Catbox 托管并填写 User Hash。');
      return;
    }
    if (typeof uploadFileToCatbox !== 'function') {
      alert('没有找到 Catbox 上传函数，请刷新页面。');
      return;
    }

    startBtn.disabled = true;
    startBtn.textContent = '上传中...';
    progress.style.display = 'block';
    failures.style.display = 'none';
    failures.textContent = '';
    let success = 0;
    let failed = 0;
    let memoryUpdated = false;
    const failedNames = [];

    for (let i = 0; i < localSongs.length; i++) {
      const { song } = localSongs[i];
      progress.textContent = `正在处理 ${i + 1} / ${localSongs.length}：${song.name || '未命名歌曲'}`;
      try {
        const blob = await songToBlob(song);
        let filename = song.name || `track-${i + 1}`;
        if (!/\.[a-z0-9]{2,5}$/i.test(filename)) {
          const ext = blob.type.includes('flac') ? 'flac' : blob.type.includes('wav') ? 'wav' : 'mp3';
          filename += `.${ext}`;
        }
        const file = new File([blob], filename, { type: blob.type || song.fileType || 'audio/mpeg' });
        const url = await uploadFileToCatbox(file);
        if (!url || !/^https?:\/\//i.test(url)) throw new Error('Catbox 没有返回 URL');

        song.src = url;
        song.isLocal = false;
        delete song.fileType;

        const memorySong = window.musicState?.playlist?.[localSongs[i].index];
        if (memorySong && isLocalSong(memorySong)) {
          memorySong.src = url;
          memorySong.isLocal = false;
          delete memorySong.fileType;
          memoryUpdated = true;
        }
        success++;
      } catch (error) {
        failed++;
        console.error('[本地歌曲迁移] 上传失败:', song.name, error);
        if (failedNames.length < 10) failedNames.push(`${song.name || '未命名歌曲'}: ${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    await db.musicLibrary.put(record);
    if (memoryUpdated && typeof window.saveGlobalPlaylist === 'function') {
      try { await window.saveGlobalPlaylist(); } catch (_) {}
    }

    progress.textContent = `完成：成功 ${success} 首，失败 ${failed} 首。`;
    if (failed) {
      failures.style.display = 'block';
      failures.textContent = '失败示例：\n' + failedNames.join('\n');
    }
    startBtn.disabled = false;
    startBtn.textContent = '重新扫描';
    startBtn.onclick = () => openLocalMusicMigration();
  }

  async function openLocalMusicMigration() {
    if (typeof db === 'undefined' || !db.musicLibrary) {
      alert('音乐库尚未加载完成。');
      return;
    }
    if (typeof state === 'undefined' || !state.apiConfig?.catboxEnable || !state.apiConfig?.catboxUserHash) {
      alert('请先在“云服务与存储”中开启 Catbox 托管并填写 User Hash。');
      return;
    }
    const record = await db.musicLibrary.get('main');
    const playlist = record?.playlist || [];
    const localSongs = playlist
      .map((song, index) => ({ song, index }))
      .filter(item => isLocalSong(item.song));

    const modal = ensureModal();
    const progress = modal.querySelector('#local-music-migration-progress');
    const failures = modal.querySelector('#local-music-migration-failures');
    const startBtn = modal.querySelector('#start-local-music-migration');
    progress.style.display = 'none';
    failures.style.display = 'none';
    modal.classList.add('visible');
    renderScan(modal, record, localSongs);
    startBtn.onclick = () => runUpload(modal, record, localSongs);
  }

  window.openLocalMusicMigration = openLocalMusicMigration;
})();
