// 本地图片迁移：扫描数据库中的 data:image 图片，按来源分类上传 ImgBB。
(function () {
  'use strict';

  const CATEGORY_DEFS = [
    {
      id: 'chatGenerated',
      label: '聊天 / 群聊 AI 生图',
      description: 'NAI、Google Imagen、GPT 生成的图片',
      defaultSelected: true
    },
    {
      id: 'chatUser',
      label: '聊天中的用户上传图',
      description: '你手动发送到聊天里的图片',
      defaultSelected: false
    },
    {
      id: 'qzone',
      label: 'QQ 动态图片',
      description: '动态中的 NAI / Imagen / GPT 图片',
      defaultSelected: true
    },
    {
      id: 'album',
      label: '情侣空间相册',
      description: '相册记录中的本地图片',
      defaultSelected: true
    },
    {
      id: 'shopping',
      label: '购物中心商品图',
      description: '商品主图和款式图',
      defaultSelected: true
    },
    {
      id: 'auction',
      label: '黑市 / 仓库物品图',
      description: '拍品和仓库物品图片',
      defaultSelected: true
    }
  ];

  const DATA_IMAGE_RE = /^data:image\//i;
  const GENERATED_MESSAGE_TYPES = new Set(['naiimag', 'googleimag', 'openaiimag', 'realimag']);

  function isDataImage(value) {
    return typeof value === 'string' && DATA_IMAGE_RE.test(value.trim());
  }

  function estimatedBytes(value) {
    if (!isDataImage(value)) return 0;
    const comma = value.indexOf(',');
    return comma >= 0 ? Math.floor((value.length - comma - 1) * 0.75) : value.length;
  }

  function formatMB(bytes) {
    return (bytes / 1024 / 1024).toFixed(2);
  }

  function makeTarget(categoryId, source, apply) {
    return { categoryId, source, size: estimatedBytes(source), apply };
  }

  async function scanChats(targets) {
    if (!db.chats) return;
    const chats = await db.chats.toArray();
    for (const chat of chats) {
      let dirty = false;
      const save = async () => {
        if (!dirty) return;
        dirty = false;
        await db.chats.put(chat);
      };
      for (const msg of (chat.history || [])) {
        if (!msg || typeof msg !== 'object') continue;

        if (GENERATED_MESSAGE_TYPES.has(msg.type) && isDataImage(msg.imageUrl)) {
          targets.push(makeTarget('chatGenerated', msg.imageUrl, async (url) => {
            msg.imageUrl = url;
            dirty = true;
            await save();
          }));
        }

        if (msg.type === 'gift' && Array.isArray(msg.items)) {
          for (const item of msg.items) {
            if (!item || !isDataImage(item.imageUrl)) continue;
            targets.push(makeTarget('chatGenerated', item.imageUrl, async (url) => {
              item.imageUrl = url;
              dirty = true;
              await save();
            }));
          }
        }

        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            const value = block?.image_url?.url;
            if (!isDataImage(value)) continue;
            targets.push(makeTarget('chatUser', value, async (url) => {
              block.image_url.url = url;
              dirty = true;
              await save();
            }));
          }
        }
      }
      await save();
    }
  }

  async function scanQzone(targets) {
    if (!db.qzonePosts) return;
    const posts = await db.qzonePosts.toArray();
    for (const post of posts) {
      let dirty = false;
      const save = async () => {
        if (!dirty) return;
        dirty = false;
        await db.qzonePosts.put(post);
      };

      if (Array.isArray(post.imageUrls)) {
        post.imageUrls.forEach((value, index) => {
          if (!isDataImage(value)) return;
          targets.push(makeTarget('qzone', value, async (url) => {
            post.imageUrls[index] = url;
            dirty = true;
            await save();
          }));
        });
      }
      if (isDataImage(post.imageUrl)) {
        targets.push(makeTarget('qzone', post.imageUrl, async (url) => {
          post.imageUrl = url;
          dirty = true;
          await save();
        }));
      }
      await save();
    }
  }

  async function scanAlbum(targets) {
    if (!db.coupleAlbumPhotos) return;
    const records = await db.coupleAlbumPhotos.toArray();
    for (const record of records) {
      const value = record?.photo?.imageData;
      if (!isDataImage(value)) continue;
      targets.push(makeTarget('album', value, async (url) => {
        record.photo.imageData = url;
        await db.coupleAlbumPhotos.put(record);
      }));
    }
  }

  async function scanShopping(targets) {
    if (!db.shoppingProducts) return;
    const products = await db.shoppingProducts.toArray();
    for (const product of products) {
      let dirty = false;
      const save = async () => {
        if (!dirty) return;
        dirty = false;
        await db.shoppingProducts.put(product);
      };

      if (isDataImage(product.imageUrl)) {
        targets.push(makeTarget('shopping', product.imageUrl, async (url) => {
          product.imageUrl = url;
          dirty = true;
          await save();
        }));
      }
      (product.variations || []).forEach((variation) => {
        if (!isDataImage(variation?.imageUrl)) return;
        targets.push(makeTarget('shopping', variation.imageUrl, async (url) => {
          variation.imageUrl = url;
          dirty = true;
          await save();
        }));
      });
      await save();
    }
  }

  async function scanAuction(targets) {
    if (!db.inventory) return;
    const items = await db.inventory.toArray();
    for (const item of items) {
      if (!isDataImage(item.image)) continue;
      targets.push(makeTarget('auction', item.image, async (url) => {
        item.image = url;
        await db.inventory.put(item);
      }));
    }
  }

  async function scanAll() {
    const targets = [];
    await scanChats(targets);
    await scanQzone(targets);
    await scanAlbum(targets);
    await scanShopping(targets);
    await scanAuction(targets);
    return targets;
  }

  function ensureModal() {
    let modal = document.getElementById('local-image-migration-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'local-image-migration-modal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:560px;">
        <div class="modal-header">
          <span>扫描并上传本地图片为 URL</span>
          <span class="close" id="close-local-image-migration" style="cursor:pointer; float:right; font-size:28px; font-weight:bold;">&times;</span>
        </div>
        <div class="modal-body" style="overflow:auto;">
          <div style="font-size:12px;color:#666;line-height:1.7;background:#f0f8ff;border-left:3px solid #007bff;padding:10px 12px;border-radius:6px;margin-bottom:12px;">
            扫描数据库中的 Base64 图片，上传 ImgBB 后把记录替换为 URL。上传到公共图床前请确认内容可以公开。
          </div>
          <div id="local-image-migration-summary" style="font-size:13px;color:#333;margin-bottom:10px;">正在扫描...</div>
          <div id="local-image-migration-categories" style="display:flex;flex-direction:column;gap:8px;"></div>
          <div id="local-image-migration-progress" style="display:none;margin-top:12px;font-size:12px;color:#555;"></div>
          <div id="local-image-migration-failures" style="display:none;margin-top:10px;font-size:12px;color:#b91c1c;white-space:pre-wrap;max-height:120px;overflow:auto;"></div>
        </div>
        <div class="modal-footer">
          <button id="cancel-local-image-migration" class="form-button form-button-secondary" style="margin-right:10px;">取消</button>
          <button id="start-local-image-migration" class="form-button" disabled>开始上传</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#close-local-image-migration')?.addEventListener('click', close);
    modal.querySelector('#cancel-local-image-migration')?.addEventListener('click', close);
    return modal;
  }

  function close() {
    const modal = document.getElementById('local-image-migration-modal');
    if (modal) modal.classList.remove('visible');
  }

  function renderScan(modal, targets) {
    const summary = modal.querySelector('#local-image-migration-summary');
    const container = modal.querySelector('#local-image-migration-categories');
    const startBtn = modal.querySelector('#start-local-image-migration');
    const counts = {};
    let totalBytes = 0;
    for (const target of targets) {
      counts[target.categoryId] = (counts[target.categoryId] || 0) + 1;
      totalBytes += target.size || 0;
    }
    const total = targets.length;
    summary.textContent = total
      ? `找到 ${total} 张本地图片，约 ${formatMB(totalBytes)} MB。请选择要处理的来源。`
      : '没有找到需要上传的 Base64 图片。';

    container.innerHTML = CATEGORY_DEFS.map(category => {
      const count = counts[category.id] || 0;
      const disabled = count === 0 ? ' disabled' : '';
      return `<label style="display:flex;align-items:flex-start;gap:8px;padding:8px;border:1px solid #eee;border-radius:8px;${count ? '' : 'opacity:.55;'}">
        <input type="checkbox" data-migration-category="${category.id}" ${count && category.defaultSelected ? 'checked' : ''}${disabled} style="margin-top:3px;">
        <span style="flex:1;">
          <span style="display:block;font-size:13px;font-weight:600;">${category.label}（${count} 张）</span>
          <span style="display:block;font-size:11px;color:#888;">${category.description}</span>
        </span>
      </label>`;
    }).join('');

    startBtn.disabled = total === 0;
    startBtn.textContent = total ? '开始上传' : '没有可上传图片';
  }

  async function uploadSelected(modal, targets) {
    const startBtn = modal.querySelector('#start-local-image-migration');
    const progress = modal.querySelector('#local-image-migration-progress');
    const failures = modal.querySelector('#local-image-migration-failures');
    const selectedCategories = new Set(
      Array.from(modal.querySelectorAll('[data-migration-category]:checked')).map(input => input.dataset.migrationCategory)
    );
    const selected = targets.filter(target => selectedCategories.has(target.categoryId));
    if (!selected.length) {
      alert('请至少选择一个来源。');
      return;
    }
    if (typeof state === 'undefined' || !state.apiConfig?.imgbbEnable || !state.apiConfig?.imgbbApiKey) {
      alert('请先开启 ImgBB 图床并填写 API Key。');
      return;
    }
    if (typeof uploadImageToImgBB !== 'function') {
      alert('没有找到 ImgBB 上传函数，请刷新页面。');
      return;
    }

    startBtn.disabled = true;
    startBtn.textContent = '上传中...';
    progress.style.display = 'block';
    failures.style.display = 'none';
    failures.textContent = '';

    const uploaded = new Map();
    let success = 0;
    let failed = 0;
    const failedLabels = [];

    for (let i = 0; i < selected.length; i++) {
      const target = selected[i];
      progress.textContent = `正在处理 ${i + 1} / ${selected.length}...`;
      try {
        const cacheKey = target.source;
        let url = uploaded.get(cacheKey);
        if (!url) {
          // uploadImageToImgBB 对 data URL 返回 URL；失败会抛错。
          if (!target.source) throw new Error('找不到原始图片数据');
          url = await uploadImageToImgBB(target.source);
          if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
            throw new Error('ImgBB 没有返回 URL');
          }
          uploaded.set(cacheKey, url);
        }
        await target.apply(url);
        success++;
      } catch (error) {
        failed++;
        console.error('[本地图片迁移] 上传失败:', error);
        if (failedLabels.length < 10) failedLabels.push(error.message || String(error));
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    progress.textContent = `完成：成功 ${success} 张，失败 ${failed} 张。`;
    if (failed) {
      failures.style.display = 'block';
      failures.textContent = '失败示例：\n' + failedLabels.join('\n');
    }
    startBtn.disabled = false;
    startBtn.textContent = '重新扫描';
    startBtn.onclick = () => openLocalImageMigration();
  }

  async function openLocalImageMigration() {
    if (typeof db === 'undefined') {
      alert('数据库尚未加载完成。');
      return;
    }
    if (typeof state === 'undefined' || !state.apiConfig?.imgbbEnable || !state.apiConfig?.imgbbApiKey) {
      alert('请先在“云服务与存储”中开启 ImgBB 图床并填写 API Key。');
      return;
    }
    const modal = ensureModal();
    const summary = modal.querySelector('#local-image-migration-summary');
    const container = modal.querySelector('#local-image-migration-categories');
    const startBtn = modal.querySelector('#start-local-image-migration');
    const progress = modal.querySelector('#local-image-migration-progress');
    const failures = modal.querySelector('#local-image-migration-failures');
    summary.textContent = '正在扫描...';
    container.innerHTML = '';
    progress.style.display = 'none';
    failures.style.display = 'none';
    startBtn.disabled = true;
    startBtn.textContent = '扫描中...';
    startBtn.onclick = null;
    modal.classList.add('visible');

    try {
      const targets = await scanAll();
      renderScan(modal, targets);
      startBtn.onclick = () => uploadSelected(modal, targets);
    } catch (error) {
      console.error('[本地图片迁移] 扫描失败:', error);
      summary.textContent = '扫描失败：' + error.message;
      startBtn.disabled = true;
      startBtn.textContent = '扫描失败';
    }
  }

  window.openLocalImageMigration = openLocalImageMigration;
})();
