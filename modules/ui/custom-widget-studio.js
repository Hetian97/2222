// 用户自制小组件：作品定义、每个桌面实例的私有内容和隔离运行环境。
window.CustomWidgetStudio = (() => {
  const packages = new Map();
  const frames = new Map();
  let database, appState, addFree, openApp, notify, overlay, pendingImageResolve, pendingImageReturn;
  const uid = () => crypto.randomUUID?.() || `widget-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const download = (name, content, type = 'application/json') => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  const button = (label, click, className = '') => {
    const node = document.createElement('button'); node.type = 'button'; node.className = className; node.textContent = label; node.onclick = click; return node;
  };
  const input = (label, value, onChange, type = 'text') => {
    const wrap = document.createElement('label'); wrap.className = 'cw-field';
    const title = document.createElement('span'); title.textContent = label;
    const control = document.createElement('input'); control.type = type; control.value = value ?? '';
    control.onchange = () => onChange(control.value);
    wrap.append(title, control); return wrap;
  };
  const example = () => ({
    format:'ephone-widget', formatVersion:1, id:uid(), name:'我的相框', author:'', description:'点击照片区域，上传你自己的照片。',
    mode:'visual', size:{ w:2, h:2 },
    fields:[{ key:'photo', label:'照片', type:'image' }, { key:'caption', label:'标题', type:'text' }],
    layers:[
      { id:uid(), type:'shape', x:3, y:3, w:94, h:94, color:'#fff9f4', radius:14 },
      { id:uid(), type:'image', x:8, y:8, w:84, h:69, field:'photo', color:'#e6d9d3', radius:7 },
      { id:uid(), type:'text', x:8, y:80, w:84, h:14, field:'caption', text:'我的相框', color:'#493b3c', fontSize:15 }
    ], html:'', css:'', script:''
  });
  const blank = () => ({
    format:'ephone-widget', formatVersion:1, id:uid(), name:'未命名小组件', author:'', description:'',
    mode:'visual', size:{w:2,h:2}, fields:[], layers:[], html:'', css:'', script:'', networkHosts:[], dataScopes:[]
  });
  const counterExample = () => ({
    ...blank(), name:'计数器', description:'点击加一或减一；每个桌面实例分别保存数字。',
    fields:[{key:'count',label:'计数',type:'number'}],
    layers:[
      {id:uid(),type:'shape',x:3,y:3,w:94,h:94,color:'#f4f6fb',radius:16},
      {id:uid(),type:'text',x:12,y:12,w:76,h:18,color:'#f4f6fb',text:'我的计数',fontSize:17},
      {id:uid(),type:'text',x:12,y:34,w:76,h:26,color:'#ffffff',field:'count',text:'0',fontSize:32,interaction:'edit'},
      {id:uid(),type:'button',x:12,y:70,w:35,h:20,color:'#e3e9f5',text:'－',fontSize:20,interaction:'decrement',actionField:'count'},
      {id:uid(),type:'button',x:53,y:70,w:35,h:20,color:'#d6e2f7',text:'＋',fontSize:20,interaction:'increment',actionField:'count'}
    ]
  });
  const checkinExample = () => ({
    ...blank(), name:'每日打卡', description:'每天点击一次，累计打卡天数；每个桌面实例独立保存。', mode:'code',
    fields:[{key:'days',label:'累计天数',type:'number'},{key:'lastDay',label:'上次打卡日期',type:'date'}],
    html:'<main><strong>每日打卡</strong><div id="days">0 天</div><button id="checkin" type="button">今天打卡</button><p id="message"></p></main>',
    css:'body{display:grid;place-items:center;background:#f4f6fb;color:#24242a}main{text-align:center;width:90%}strong{font-size:17px}#days{font-size:30px;margin:12px 0}button{border:0;border-radius:10px;background:#333840;color:white;padding:9px 18px;font:inherit}p{font-size:12px;color:#666}',
    script:`const days = document.getElementById('days');
const button = document.getElementById('checkin');
const message = document.getElementById('message');
const today = () => new Date().toLocaleDateString('sv-SE');
function render() {
  days.textContent = (Number(EPhoneWidget.get('days')) || 0) + ' 天';
  button.disabled = EPhoneWidget.get('lastDay') === today();
  message.textContent = button.disabled ? '今天已完成' : '点击按钮记录今天';
}
button.addEventListener('click', async () => {
  if (EPhoneWidget.get('lastDay') === today()) return;
  button.disabled = true;
  try {
    await EPhoneWidget.set('days', String((Number(EPhoneWidget.get('days')) || 0) + 1));
    await EPhoneWidget.set('lastDay', today());
    render();
  } catch (error) { button.disabled = false; message.textContent = '保存失败：' + error.message; }
});
render();`
  });
  const countdownExample = () => ({
    ...blank(), name:'重要日子倒数', description:'填写目标日期后，显示还剩多少天。',
    fields:[{key:'targetDate',label:'目标日期',type:'date'}],
    layers:[
      {id:uid(),type:'shape',x:3,y:3,w:94,h:94,color:'#f5f1fa',radius:16},
      {id:uid(),type:'text',x:10,y:18,w:80,h:18,color:'#f5f1fa',text:'距离重要日子',fontSize:17},
      {id:uid(),type:'countdown',x:10,y:43,w:80,h:30,color:'#ffffff',field:'targetDate',fontSize:27,interaction:'edit'},
      {id:uid(),type:'button',x:20,y:80,w:60,h:12,color:'#e6dff0',text:'修改日期',field:'targetDate',fontSize:12,interaction:'edit'}
    ]
  });
  function validate(raw) {
    if (!raw || raw.format !== 'ephone-widget' || raw.formatVersion !== 1) throw new Error('不是受支持的小组件包');
    const value = structuredClone(raw);
    delete value._needsFieldReview;
    if (!/^[\w-]{8,100}$/.test(String(value.id || ''))) throw new Error('小组件 ID 无效');
    if (!String(value.name || '').trim()) throw new Error('请填写小组件名称');
    value.name = String(value.name).trim().slice(0, 50);
    value.author = String(value.author || '').slice(0, 50);
    value.description = String(value.description || '').slice(0, 300);
    value.mode = value.mode === 'code' ? 'code' : 'visual';
    value.networkHosts = [...new Set((Array.isArray(value.networkHosts) ? value.networkHosts : []).map(host => String(host).toLowerCase().trim()))].filter(host => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host)).slice(0, 8);
    value.dataScopes = [...new Set((Array.isArray(value.dataScopes) ? value.dataScopes : []).filter(scope => ['todoCount','musicStatus'].includes(scope)))];
    value.size = { w:Math.max(1, Math.min(4, Math.floor(Number(value.size?.w) || 2))), h:Math.max(1, Math.min(4, Math.floor(Number(value.size?.h) || 2))) };
    if (!Array.isArray(value.fields) || value.fields.length > 30) throw new Error('可填写项目数量无效');
    const seen = new Set();
    value.fields = value.fields.map(field => {
      const key = String(field.key || '');
      if (!/^[a-z][\w-]{0,39}$/i.test(key) || ['constructor','prototype','toString','valueOf'].includes(key) || seen.has(key)) throw new Error('可填写项目名称重复或无效');
      seen.add(key);
      if (!['text','image','date','number'].includes(field.type)) throw new Error('可填写项目类型无效');
      return { key, label:String(field.label || key).slice(0, 50), type:field.type, defaultValue:String(field.defaultValue || '').slice(0, 2000) };
    });
    if (!Array.isArray(value.layers) || value.layers.length > 80) throw new Error('图层数量无效');
    value.layers = value.layers.map(layer => ({
      id:String(layer.id || uid()).slice(0, 100), type:['shape','image','text','button','clock','date','countdown','progress','list'].includes(layer.type) ? layer.type : 'shape',
      x:Math.max(0, Math.min(100, Number(layer.x) || 0)), y:Math.max(0, Math.min(100, Number(layer.y) || 0)),
      w:Math.max(2, Math.min(100, Number(layer.w) || 20)), h:Math.max(2, Math.min(100, Number(layer.h) || 20)),
      color:/^#[0-9a-f]{6}$/i.test(String(layer.color || '')) ? layer.color : '#ffffff', radius:Math.max(0, Math.min(100, Number(layer.radius) || 0)),
      fontSize:Math.max(8, Math.min(60, Number(layer.fontSize) || 16)), text:String(layer.text || '').slice(0, 300),
      textColor:/^#[0-9a-f]{3,8}$/i.test(String(layer.textColor || '')) ? layer.textColor : '#29242a',
      field:seen.has(layer.field) ? layer.field : '', action:['','edit','flip','settings','app'].includes(layer.action) ? layer.action : '',
      interaction:['','edit','flip','settings','app','increment','decrement','reset','toggle'].includes(layer.interaction) ? layer.interaction : undefined,
      actionField:seen.has(layer.actionField) ? layer.actionField : '',
      visibleField:seen.has(layer.visibleField) ? layer.visibleField : '', visibleValue:String(layer.visibleValue ?? '').slice(0,100),
      maxValue:Math.max(1,Math.min(1000000,Number(layer.maxValue)||100)),
      appKey:String(layer.appKey || '').slice(0,100),
      side:layer.side === 'back' ? 'back' : 'front',
      src:typeof layer.src === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(layer.src) && layer.src.length < 350000 ? layer.src : '',
      dataScope:['todoCount','musicStatus'].includes(layer.dataScope) ? layer.dataScope : '',
      dataUrl:typeof layer.dataUrl === 'string' && /^https:\/\//i.test(layer.dataUrl) ? layer.dataUrl.slice(0,500) : '',
      dataPath:String(layer.dataPath || '').slice(0,100)
    }));
    value.layers.forEach(layer => {
      layer.x = Math.min(layer.x, 100 - layer.w); layer.y = Math.min(layer.y, 100 - layer.h);
      if (layer.dataScope && !value.dataScopes.includes(layer.dataScope)) value.dataScopes.push(layer.dataScope);
      if (layer.dataUrl) { try { const host=new URL(layer.dataUrl).hostname; if (!value.networkHosts.includes(host)) value.networkHosts.push(host); } catch (_) { layer.dataUrl=''; } }
    });
    value.html = String(value.html || '').slice(0, 100000);
    value.css = String(value.css || '').slice(0, 100000);
    value.script = String(value.script || '').slice(0, 100000);
    if (JSON.stringify(value).length > 500000) throw new Error('小组件包过大');
    return value;
  }
  function visualMarkup(pkg, values) {
    return pkg.layers.map(layer => {
      if (layer.visibleField && String(values[layer.visibleField] ?? '') !== layer.visibleValue) return '';
      const field = pkg.fields.find(entry => entry.key === layer.field);
      const position = `left:${layer.x}%;top:${layer.y}%;width:${layer.w}%;height:${layer.h}%;background:${/^#[0-9a-f]{3,8}$/i.test(layer.color) ? layer.color : '#ffffff'};border-radius:${layer.radius}px;`;
      const interaction = layer.interaction === undefined ? (field ? 'edit' : layer.action) : layer.interaction;
      const action = interaction ? `data-widget-action="${esc(interaction)}" data-widget-field="${esc(interaction === 'edit' ? layer.field : layer.actionField)}" data-widget-app="${esc(layer.appKey)}"` : '';
      const binding = layer.dataScope ? `data-scope="${esc(layer.dataScope)}"` : layer.dataUrl ? `data-url="${esc(layer.dataUrl)}" data-path="${esc(layer.dataPath)}"` : '';
      let contents = '';
      if (layer.type === 'image') contents = values[field?.key] || layer.src ? `<img src="${esc(values[field?.key] || layer.src)}" alt="${esc(field?.label || '图片')}">` : `<span>${esc(field?.label || '图片')}</span>`;
      else if (layer.type === 'clock') contents = '<span data-clock></span>';
      else if (layer.type === 'date') contents = '<span data-date></span>';
      else if (layer.type === 'countdown') contents = `<span data-countdown="${esc(values[field?.key] || '')}">${values[field?.key] ? '' : '设置日期'}</span>`;
      else if (layer.type === 'progress') {const percent=Math.max(0,Math.min(100,(Number(values[field?.key])||0)/layer.maxValue*100));contents=`<span class="progress-track"><span style="width:${percent}%"></span></span>`;}
      else if (layer.type === 'list') contents = `<ul>${String(values[field?.key] || layer.text || '').split(/\r?\n/).filter(Boolean).slice(0,6).map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`;
      else if (layer.type !== 'shape') contents = `<span>${esc(values[field?.key] ?? layer.text ?? '')}</span>`;
      return `<div class="layer ${esc(layer.type)} ${layer.side === 'back' ? 'back-side' : 'front-side'}" style="${position}font-size:${layer.fontSize}px;color:${layer.textColor}" ${action} ${binding}>${contents}</div>`;
    }).join('');
  }
  function source(pkg, values, token, preview = false) {
    const nonce = uid().replace(/[^a-z0-9]/gi, '');
    const csp = `default-src 'none'; img-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'none'; frame-src 'none'; navigate-to 'none'; form-action 'none'; base-uri 'none'`;
    const safeValues = JSON.stringify(values).replace(/</g, '\\u003c');
    const boot = `(() => {
      const token=${JSON.stringify(token)}, values=${safeValues}, preview=${Boolean(preview)};
      let request=0; const waiting=new Map();
      window.EPhoneWidget=Object.freeze({
        get:key=>values[key],
        edit:key=>send('edit',{key}),
        set:(key,value)=>send('set',{key,value}),
        openSettings:()=>send('settings',{}),
        fetch:url=>send('fetch',{url}),
        read:scope=>send('read',{scope}),
        openApp:key=>send('openApp',{key})
      });
      function send(op,data){return new Promise((resolve,reject)=>{const id=++request; waiting.set(id,{resolve,reject}); parent.postMessage({ephoneWidget:true,token,id,op,...data},'*');});}
      addEventListener('message',event=>{const message=event.data;if(!message||message.token!==token||!waiting.has(message.id))return;const task=waiting.get(message.id);waiting.delete(message.id);if(message.error)task.reject(new Error(message.error));else {if(message.key)values[message.key]=message.value;task.resolve(message.value);}});
      addEventListener('error',event=>{if(document.getElementById('widget-error'))return;const note=document.createElement('div');note.id='widget-error';note.style.cssText='position:absolute;inset:auto 5px 5px;padding:5px;border-radius:6px;background:#7d2626;color:#fff;font:11px/1.3 sans-serif;z-index:999';note.textContent='小组件脚本出错：'+String(event.message||'未知错误').slice(0,120);document.body.append(note);});
      document.addEventListener('click',async event=>{const target=event.target.closest('[data-widget-action]');if(!target)return;const action=target.dataset.widgetAction,key=target.dataset.widgetField;try{
        if(action==='edit')await EPhoneWidget.edit(key);
        else if(action==='flip')document.body.classList.toggle('flipped');
        else if(action==='settings')await EPhoneWidget.openSettings();
        else if(action==='app')await EPhoneWidget.openApp(target.dataset.widgetApp);
        else if(['increment','decrement','reset','toggle'].includes(action)){
          if(!key)return;
          const previous=EPhoneWidget.get(key);
          const next=action==='toggle'?(previous==='1'?'0':'1'):action==='reset'?'0':String((Number(previous)||0)+(action==='increment'?1:-1));
          await EPhoneWidget.set(key,next);
        }
      }catch(error){let note=document.getElementById('widget-action-error');if(!note){note=document.createElement('p');note.id='widget-action-error';note.style.cssText='position:absolute;left:4px;right:4px;bottom:2px;background:#7d2626;color:white;font:11px sans-serif;padding:4px;z-index:999';document.body.append(note);}note.textContent=error.message;}});
      const tick=()=>{document.querySelectorAll('[data-clock]').forEach(el=>el.textContent=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}));document.querySelectorAll('[data-date]').forEach(el=>el.textContent=new Date().toLocaleDateString('zh-CN'));document.querySelectorAll('[data-countdown]').forEach(el=>{const target=new Date(el.dataset.countdown+'T00:00:00');if(!Number.isFinite(target.getTime()))return;const now=new Date();now.setHours(0,0,0,0);const days=Math.round((target-now)/86400000);el.textContent=days>0?'还有 '+days+' 天':days===0?'就是今天':'已过 '+Math.abs(days)+' 天';});};tick();setInterval(tick,30000);
      const update=async()=>{for(const el of document.querySelectorAll('[data-scope],[data-url]')){try{let value;if(el.dataset.scope)value=await EPhoneWidget.read(el.dataset.scope);else{const raw=await EPhoneWidget.fetch(el.dataset.url);try{value=JSON.parse(raw);for(const part of (el.dataset.path||'').split('.').filter(Boolean))value=value?.[part];}catch(_){value=raw;}}el.textContent=typeof value==='object'?(value?.title||JSON.stringify(value)):String(value??'');}catch(_){el.textContent='暂不可用';}}};if(!preview){update();setInterval(update,300000);}
    })();`;
    const custom = String(pkg.script || '').replace(/<\//g, '<\\/');
    return `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${esc(csp)}"><style>html,body{width:100%;height:100%;margin:0;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif}body{position:relative}*,*:before,*:after{box-sizing:border-box}.layer{position:absolute;display:flex;align-items:center;justify-content:center;overflow:hidden;overflow-wrap:anywhere;text-align:center}.layer.image{cursor:pointer}.layer.image img{width:100%;height:100%;object-fit:cover}.layer.list ul{width:100%;height:100%;margin:0;padding:4px 5px 4px 22px;text-align:left;overflow:hidden}.layer.list li{line-height:1.35}.progress-track{display:block;width:90%;height:34%;min-height:7px;border-radius:999px;background:#e6e8ef;overflow:hidden}.progress-track>span{display:block;height:100%;border-radius:inherit;background:currentColor}.back-side,.flipped .front-side{display:none}.flipped .back-side{display:flex}${String(pkg.css || '').replace(/<\//g, '<\\/')}</style></head><body>${pkg.mode === 'code' ? String(pkg.html || '') : visualMarkup(pkg,values)}<script nonce="${nonce}">${boot.replace(/<\//g, '<\\/')}</script><script nonce="${nonce}">${custom}</script></body></html>`;
  }
  function frame(pkg, instanceId, values = {}, previewReturn = null) {
    for (const old of frames.keys()) if (!old.isConnected) frames.delete(old);
    const iframe = document.createElement('iframe');
    iframe.className = 'cw-frame'; iframe.title = pkg.name;
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    const token = uid();
    pkg.fields.forEach(field => { if (values[field.key] == null && field.defaultValue) values[field.key] = field.defaultValue; });
    frames.set(iframe, { pkg, instanceId, token, values, previewReturn });
    iframe.srcdoc = source(pkg, values, token, !instanceId);
    return iframe;
  }
  async function pickImage(maxDimension = 1600, quality = .85, outputType = 'image/jpeg') {
    return new Promise(resolve => {
      const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/*'; picker.hidden = true;
      document.body.append(picker);
      picker.onchange = async () => {
        const file = picker.files?.[0]; picker.remove();
        if (!file) return resolve(null);
        if (file.size > 12 * 1024 * 1024) { notify('图片不能超过 12 MB'); return resolve(null); }
        try {
          const bitmap = await createImageBitmap(file);
          const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
          const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close?.();
          resolve(canvas.toDataURL(outputType, quality));
        } catch (_) {
          const url = URL.createObjectURL(file);
          const image = new Image();
          image.onload = () => {
            const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
            const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url); resolve(canvas.toDataURL(outputType, quality));
          };
          image.onerror = () => { URL.revokeObjectURL(url); notify('无法读取这张图片'); resolve(null); };
          image.src = url;
        }
      };
      picker.oncancel = () => { picker.remove(); resolve(null); };
      picker.click();
    });
  }
  function requestImage(label, onCancel = null) {
    return new Promise(resolve => {
      pendingImageResolve = resolve;
      pendingImageReturn = onCancel;
      const body = document.createElement('div'); body.className = 'cw-form';
      const note = document.createElement('p'); note.className = 'cw-note'; note.textContent = `为「${label}」选择你自己的照片。照片只保存在当前桌面组件里。`;
      body.append(note, button('选择照片', async () => { const value = await pickImage(); pendingImageResolve = null; pendingImageReturn = null; close(); resolve(value); if(!value)onCancel?.(); }, 'cw-primary'));
      body.append(button('取消', () => close()));
      show('更换照片',body);
    });
  }
  async function saveValue(context, key, value) {
    const field = context.pkg.fields.find(entry => entry.key === key);
    if (!field) throw new Error('此内容项不存在');
    if (typeof value !== 'string' || value.length > (field.type === 'image' ? 6_000_000 : 2000)) throw new Error('内容过大');
    if (field.type === 'image' && value && !/^data:image\/(png|jpeg|webp);base64,/.test(value)) throw new Error('图片格式无效');
    if (!context.instanceId) { context.values[key] = value; return; }
    const record = await database.customWidgetInstances.get(context.instanceId) || { id:context.instanceId, packageId:context.pkg.id, values:{} };
    record.values = { ...record.values, [key]:value }; record.updatedAt = Date.now();
    await database.customWidgetInstances.put(record);
    context.values = record.values;
  }
  async function editField(context, key, fromFrame = false) {
    const field = context.pkg.fields.find(entry => entry.key === key);
    if (!field) throw new Error('此内容项不存在');
    let value;
    if (field.type === 'image') value = fromFrame ? await requestImage(field.label,context.previewReturn) : await pickImage();
    else value = await window.showCustomPrompt(context.pkg.name, esc(field.label), esc(context.values[key] || ''), field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : context.pkg.layers.some(layer=>layer.type==='list'&&layer.field===key) ? 'textarea' : 'text');
    if (value == null) return null;
    await saveValue(context, key, String(value));
    return String(value);
  }
  async function onMessage(event) {
    const data = event.data;
    if (!data?.ephoneWidget) return;
    const entry = [...frames].find(([iframe, context]) => iframe.contentWindow === event.source && context.token === data.token);
    if (!entry) return;
    const [iframe, context] = entry;
    const answer = { token:context.token, id:data.id };
    try {
      if (data.op === 'edit') { answer.key = data.key; answer.value = await editField(context, data.key, true); }
      else if (data.op === 'set') { await saveValue(context, data.key, data.value); answer.key = data.key; answer.value = data.value; }
      else if (data.op === 'settings') { openInstanceSettings(context, () => { iframe.srcdoc = source(context.pkg, context.values, context.token, !context.instanceId); }); answer.value = true; }
      else if (data.op === 'fetch') {
        if (!context.instanceId) throw new Error('预览中不能联网');
        const url = new URL(data.url);
        if (url.protocol !== 'https:' || !context.pkg.networkHosts?.includes(url.hostname)) throw new Error('此小组件未获准访问该网站');
        if (!await permission(context.pkg, `联网访问 ${url.hostname}`)) throw new Error('没有联网授权');
        const response = await fetch(url.href, { credentials:'omit', referrerPolicy:'no-referrer' });
        if (!response.ok) throw new Error('网络请求失败');
        const value = await response.text(); if (value.length > 100000) throw new Error('网络响应过大'); answer.value = value;
      } else if (data.op === 'read') {
        if (!context.instanceId) throw new Error('预览中不能读取应用数据');
        if (!context.pkg.dataScopes?.includes(data.scope)) throw new Error('此小组件未声明该数据权限');
        if (!await permission(context.pkg, `读取 ${data.scope === 'todoCount' ? '当前角色今日待办数量' : '音乐播放状态'}`)) throw new Error('没有数据授权');
        if (data.scope === 'todoCount') {
          const todos = appState.chats?.[appState.activeChatId]?.todoList || [];
          const now = new Date(); const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
          answer.value = todos.filter(item => item.date === today && item.status !== 'completed').length;
        } else answer.value = { playing:!!window.musicState?.isPlaying, title:String(window.musicState?.playlist?.[window.musicState.currentIndex]?.name || '') };
      } else if (data.op === 'openApp') {
        if (!context.instanceId) throw new Error('预览中不能打开应用');
        if (typeof data.key !== 'string' || !/^[\w-]{1,100}$/.test(data.key)) throw new Error('应用入口无效');
        if (!await permission(context.pkg, `打开应用 ${data.key}`)) throw new Error('没有打开应用的授权');
        openApp(data.key); answer.value = true;
      } else throw new Error('不支持的操作');
    } catch (error) { answer.error = error.message || '操作失败'; notify(answer.error); }
    event.source?.postMessage(answer, '*');
    if ((data.op === 'edit' && answer.value != null) || (data.op === 'set' && !answer.error && context.pkg.mode === 'visual')) setTimeout(() => { if (iframe.isConnected) iframe.srcdoc = source(context.pkg, context.values, context.token, !context.instanceId); else if (context.previewReturn) context.previewReturn(); }, 0);
  }
  async function permission(pkg, description) {
    appState.globalSettings.customWidgetPermissions ||= {};
    const key = `${pkg.id}:${description}`;
    if (appState.globalSettings.customWidgetPermissions[key]) return true;
    const allowed = await window.showCustomConfirm('小组件权限', `「${esc(pkg.name)}」请求${esc(description)}。允许吗？`);
    if (allowed) { appState.globalSettings.customWidgetPermissions[key] = true; await database.globalSettings.put(appState.globalSettings); }
    return allowed;
  }
  function openInstanceSettings(context, done = () => {}) {
    context.pkg.fields.forEach(field=>{if(context.values[field.key]==null&&field.defaultValue)context.values[field.key]=field.defaultValue;});
    const body = document.createElement('div'); body.className = 'cw-form';
    context.pkg.fields.forEach(field => body.append(button(`${field.type === 'image' ? '更换' : '编辑'}${field.label}`, async () => {
      try { const value = await editField(context, field.key); if (value != null) { done(); if(context.previewReturn)context.previewReturn();else openInstanceSettings(context, done); } } catch (error) { notify(error.message); }
    }, 'cw-row-button')));
    if (!context.pkg.fields.length) body.append(Object.assign(document.createElement('p'), { textContent:'此小组件没有需要填写的内容。' }));
    if(context.previewReturn)body.append(button('返回预览',context.previewReturn));
    show('配置小组件', body);
  }
  async function makePlacedFrame(packageId, instanceId) {
    const pkg = packages.get(packageId);
    if (!pkg) { const note = document.createElement('span'); note.textContent = '小组件未安装'; return note; }
    const record = await database.customWidgetInstances.get(instanceId);
    return frame(pkg, instanceId, record?.values || {});
  }
  function mount(packageId, instanceId, container) {
    makePlacedFrame(packageId, instanceId).then(node => { if (container.isConnected) container.replaceChildren(node); }).catch(error => { container.textContent = `加载失败：${error.message}`; });
  }
  function show(title, contents) {
    overlay.querySelector('.cw-title').textContent = title;
    overlay.querySelector('.cw-body').replaceChildren(contents);
    overlay.hidden = false;
  }
  function close() { const restore=pendingImageReturn;pendingImageReturn=null;if (pendingImageResolve) { pendingImageResolve(null); pendingImageResolve = null; } overlay.hidden = true; overlay.querySelector('.cw-body').replaceChildren();restore?.(); }
  async function putPackage(raw, replace = false) {
    const pkg = validate(raw);
    if (packages.has(pkg.id) && !replace) throw new Error('已有相同 ID 的小组件，请在库中编辑原作品或修改 ID');
    await database.customWidgetPackages.put({ ...pkg, updatedAt:Date.now() });
    packages.set(pkg.id, pkg);
    for (const [iframe, context] of frames) if (context.pkg.id === pkg.id && iframe.isConnected) {
      context.pkg = pkg; iframe.srcdoc = source(pkg, context.values, context.token, !context.instanceId);
    }
    return pkg;
  }
  function packagesForLayout(layout) {
    const ids = new Set((layout.pages || []).flat().filter(item => item.kind === 'widget' && String(item.key || '').startsWith('custom:')).map(item => item.key.slice(7)));
    return [...ids].map(id => packages.get(id)).filter(Boolean).map(pkg => { const copy=structuredClone(pkg);delete copy.updatedAt;return copy; });
  }
  async function installLayoutPackages(list) {
    if (!Array.isArray(list) || !list.length) return;
    if (list.length > 40) throw new Error('布局包含过多小组件');
    const missing = list.map(validate).filter(pkg => !packages.has(pkg.id));
    if (!missing.length) return;
    if (!await window.showCustomConfirm('导入布局中的小组件', `此布局包含 ${missing.length} 个尚未安装的自制小组件。安装后再应用布局吗？`)) throw new Error('已取消导入');
    for (const pkg of missing) await putPackage(pkg);
  }
  async function freshenLayoutInstances(layout) {
    for (const page of layout.pages || []) for (const item of page) {
      if (item.kind !== 'widget' || !String(item.key || '').startsWith('custom:')) continue;
      const id = uid(), packageId = item.key.slice(7);
      item.id = id;
      await database.customWidgetInstances.put({ id, packageId, values:{}, updatedAt:Date.now() });
    }
    return layout;
  }
  async function cleanupOrphans() {
    const live = new Set(appState.globalSettings.classicCustomWidgetIds || []);
    const free = appState.globalSettings.freeHomeLayout;
    (free?.pages || []).flat().forEach(item => { if (item.kind === 'widget' && String(item.key || '').startsWith('custom:')) live.add(item.id); });
    (free?.deletedWidgets || []).forEach(item => { if (String(item.key || '').startsWith('custom:')) live.add(item.id); });
    const records = await database.customWidgetInstances.toArray();
    const unused = records.filter(record => !live.has(record.id));
    if (unused.length) await database.customWidgetInstances.bulkDelete(unused.map(record => record.id));
  }
  function codePackage(html, css = '', script = '', name = 'AI 制作的小组件') {
    if (/<(?:script|style)\b/i.test(html)) throw new Error('HTML 中仍含 script 或 style；请分别粘贴到 JavaScript 和 CSS 输入框');
    const pkg = blank();
    pkg.name = name.trim() || pkg.name;
    pkg.mode = 'code'; pkg.html = html; pkg.css = css; pkg.script = script;
    const keys = [...script.matchAll(/EPhoneWidget\.(?:get|edit|set)\(\s*['"]([a-z][\w-]{0,39})['"]/gi)].map(match => match[1]);
    pkg.fields = [...new Set(keys)].map(key => ({key,label:key,type:'text'}));
    pkg._needsFieldReview = pkg.fields.length > 0;
    return pkg;
  }
  function htmlPackage(markup, name = 'AI 制作的小组件') {
    const page = new DOMParser().parseFromString(markup, 'text/html');
    if (page.querySelector('script[src],link[rel="stylesheet"],iframe,object,embed')) throw new Error('代码引用了外部脚本、样式或嵌入页面；请让 AI 改为独立的 HTML、CSS、JavaScript 内容');
    const scripts = [...page.querySelectorAll('script')].map(node => node.textContent || '');
    const styles = [...page.querySelectorAll('style')].map(node => node.textContent || '');
    page.querySelectorAll('script,style').forEach(node => node.remove());
    if ([...page.body.querySelectorAll('*')].some(node => [...node.attributes].some(attribute => /^on/i.test(attribute.name)))) throw new Error('HTML 使用了内联点击代码；请让 AI 把事件处理移入 JavaScript');
    return codePackage(page.body.innerHTML, styles.join('\n'), scripts.join('\n'), page.title || name);
  }
  function parseImportText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('请粘贴小组件内容');
    const fencedJson = trimmed.match(/```(?:json|ephonewidget)\s*\n([\s\S]*?)\n```/i) || trimmed.match(/^```\s*\n([\s\S]*?)\n```\s*$/i);
    const content = fencedJson ? fencedJson[1].trim() : trimmed;
    if (content.startsWith('{')) return JSON.parse(content);
    const blocks = [...trimmed.matchAll(/```\s*(html|css|javascript|js)\s*\n([\s\S]*?)\n```/gi)];
    if (blocks.length) {
      const parts = Object.fromEntries(blocks.map(match => [match[1].toLowerCase() === 'javascript' ? 'js' : match[1].toLowerCase(), match[2]]));
      if (!parts.html) throw new Error('代码块中缺少 HTML；请粘贴完整作品 JSON 或 HTML、CSS、JavaScript 三段代码');
      return codePackage(parts.html, parts.css || '', parts.js || '');
    }
    if (/^\s*<(?:!doctype\s+html|[a-z][\w-]*\b)/i.test(content)) return htmlPackage(content);
    throw new Error('无法识别内容；请粘贴完整作品 JSON、HTML 文件或分别标明 HTML/CSS/JavaScript 的代码块');
  }
  function aiInstructions(pkg = null, request = '') {
    const sample = checkinExample();
    return `请为 EPhone 应用内桌面制作一个可以导入、可以分享给其他人的小组件。\n用户需求：${request.trim() || '（在这里填写希望小组件显示什么、点击后做什么、使用者需要填写什么）'}\n\n默认只返回完整的 .ephonewidget JSON 内容，不要只给截图、设计说明或零散代码。不要用 Markdown 代码围栏。若某项需求超出下述能力，请明确指出，不要声称已经实现。\n\n作品格式：format 固定为 "ephone-widget"；formatVersion 固定为 1；id 是 8～100 位英文字母、数字、下划线或连字符的唯一标识；name 是作品名；author、description 可选；size 为 {"w":2,"h":2}，宽高各 1～4 格；mode 为 "visual" 或 "code"；fields 是使用者或组件保存的字段数组，每项有 key、label、type，type 可为 text、number、date、image，可有 defaultValue；layers 为可视化图层数组，代码模式可用空数组；代码模式分别在 html、css、script 中填写 HTML、CSS、JavaScript；networkHosts 和 dataScopes 为权限声明数组。可视化图层 type 支持 shape、image、text、button、clock、date、countdown、progress、list；位置 x/y/w/h 为画布百分比，field 绑定字段，interaction 可为 edit、increment、decrement、reset、toggle、flip、settings、app，数字动作用 actionField 指定字段。复杂交互建议使用代码模式。\n\n代码模式中，HTML 只放界面元素，CSS 只放样式，JavaScript 只放逻辑。不要使用外部 script、iframe、内联 onclick 或需要直接访问 EPhone 主页面的代码。组件在隔离环境运行。EPhoneWidget.get(key) 读取当前桌面实例的字段值；await EPhoneWidget.edit(key) 让使用者填写；await EPhoneWidget.set(key, String(value)) 保存当前实例的字段值；await EPhoneWidget.openSettings() 打开填写菜单；await EPhoneWidget.openApp(appId) 打开 EPhone 应用。await EPhoneWidget.read(scope) 当前只支持 todoCount 和 musicStatus，必须在 dataScopes 声明且由使用者授权。await EPhoneWidget.fetch(httpsUrl) 必须在 networkHosts 声明域名且由使用者授权，目标服务还须允许浏览器跨域读取。普通 JavaScript 可以实现计时、计算、按钮交互；应用关闭后不保证后台持续运行。这是 EPhone 应用内桌面组件，不是 iOS/Android 系统桌面 Widget。\n\n所有需要保存的值都必须先在 fields 声明。每个接收者、每个桌面实例的填写值分别保存；不要把私人照片或使用者数据写进作品包。请确保点击后有可见反馈，刷新后状态正确。作品包应小于 500 KB。\n\n完整可导入范例（每日打卡）：\n${JSON.stringify(sample, null, 2)}${pkg ? `\n\n请基于以下现有作品修改。保持 id 可替换原作品；若想作为另一件作品，请使用新 id。保留仍有用途的字段、功能和权限：\n${JSON.stringify(pkg, null, 2)}` : ''}`;
  }
  function openAI(pkg = null) {
    const body = document.createElement('div'); body.className = 'cw-form';
    const note = document.createElement('p'); note.className = 'cw-note';
    note.textContent = pkg ? `把要求与「${pkg.name}」的作品说明一起发给任意 AI，得到完整作品后在这里导入。` : '描述想要的功能，把下方说明发给任意 AI；得到结果后在这里导入。无需先制作一个作品。';
    const demand = document.createElement('label'); demand.className = 'cw-field'; demand.textContent = '我想做的小组件';
    const request = document.createElement('textarea'); request.placeholder = '例如：每天点击一次打卡，显示累计天数；每个人有自己的记录。';
    const prompt = document.createElement('textarea'); prompt.className = 'cw-ai-prompt'; prompt.readOnly = true;
    const update = () => { prompt.value = aiInstructions(pkg, request.value); }; request.oninput = update; update();
    const promptLabel = document.createElement('label'); promptLabel.className = 'cw-field'; promptLabel.textContent = '复制以下完整要求给 AI'; promptLabel.append(prompt);
    demand.append(request);
    const actions = document.createElement('div'); actions.className = 'cw-actions';
    actions.append(button('复制给 AI', async () => { try { await navigator.clipboard.writeText(prompt.value); notify('已复制制作要求'); } catch (_) { prompt.focus(); prompt.select(); notify('无法自动复制，已选中说明，请手动复制'); } }, 'cw-primary'),
      button('下载说明', () => download(pkg ? `${pkg.name}-交给AI修改.txt` : 'EPhone小组件-AI制作说明.txt', prompt.value, 'text/plain;charset=utf-8')),
      button('导入 AI 结果', openImportHub),button('返回我的小组件',openLibrary));
    body.append(note,demand,promptLabel,actions);
    show(pkg ? '交给 AI 修改' : '让 AI 制作小组件',body);
  }
  async function importFile(file) {
    if (!file || file.size > 1024 * 1024) throw new Error('小组件文件不能超过 1 MB');
    const raw = parseImportText(await file.text());
    const pkg = validate(raw);
    const details = [pkg.networkHosts.length ? `联网：${pkg.networkHosts.join('、')}` : '',pkg.dataScopes.length ? `应用数据：${pkg.dataScopes.join('、')}` : ''].filter(Boolean).join('；');
    const body = document.createElement('div'); body.className = 'cw-form';
    const note = document.createElement('p'); note.className = 'cw-note';
    note.textContent = `${pkg.name}${pkg.author ? ` · ${pkg.author}` : ''}。${pkg.description || '作品未填写功能说明。'} ${details || '无需额外权限'}。${packages.has(pkg.id) ? '安装会替换同 ID 的作品，桌面上已填写的内容会保留。' : '每个人放到桌面后填写自己的内容。'}`;
    const fields = document.createElement('p'); fields.className = 'cw-note';
    fields.textContent = pkg.fields.length ? `使用者可填写或保存：${pkg.fields.map(field => field.label).join('、')}。` : '此作品没有需要填写或保存的内容。';
    const warnings = inspectPackage(pkg);
    if(raw._needsFieldReview)warnings.push('代码中的字段已自动识别为文字；若有图片、数字或日期，请点「先调整作品」修改类型。');
    const warning = document.createElement('p'); warning.className = 'cw-note cw-warning'; warning.textContent = warnings.join('；'); warning.hidden = !warnings.length;
    const previous = packages.get(pkg.id);
    if(previous){const removed=previous.fields.filter(field=>!pkg.fields.some(next=>next.key===field.key));if(removed.length){warning.textContent += `${warning.textContent?'；':''}原作品的 ${removed.map(field=>field.label).join('、')} 已不在新作品中；原有填写值仍保存，但新界面不会显示它们。`;warning.hidden=false;}}
    const preview = document.createElement('div'); preview.className = 'cw-preview'; preview.style.aspectRatio = `${pkg.size.w}/${pkg.size.h}`; preview.style.setProperty('--cw-ratio',pkg.size.w/pkg.size.h);
    const previewValues = {};
    const previewFrame = frame(pkg,null,previewValues); previewFrame.style.pointerEvents='none'; preview.append(previewFrame);
    const actions = document.createElement('div'); actions.className = 'cw-actions';
    actions.append(button(packages.has(pkg.id) ? '替换作品' : '安装小组件', async () => {
      try { await putPackage(pkg,true); close(); notify(`已导入「${pkg.name}」`); openLibrary(); }
      catch (error) { notify(error.message); }
    }, 'cw-primary'),button('试用功能',()=>openPreview(pkg,previewValues,()=>show('预览并导入',body))),button('先调整作品',()=>openEditor(pkg)),button('取消',close));
    body.append(note,fields,warning,preview,actions); show('预览并导入',body);
  }
  function inspectPackage(pkg) {
    const warnings = [];
    if (pkg.mode === 'visual') {
      if (!pkg.layers.length) warnings.push('画布还是空的，保存后组件不会显示内容');
      const unused = pkg.fields.filter(field => !pkg.layers.some(layer => layer.field === field.key || layer.actionField === field.key || layer.visibleField === field.key));
      if (unused.length) warnings.push(`以下填写项未连接到图层：${unused.map(field => field.label).join('、')}`);
      pkg.layers.forEach(layer => {
        if (['increment','decrement','reset','toggle'].includes(layer.interaction) && !layer.actionField) warnings.push('有按钮尚未选择要修改的内容');
        if ((layer.interaction || layer.action) === 'app' && !layer.appKey) warnings.push('有打开应用动作尚未填写应用 ID');
        if (layer.interaction === 'edit' && !layer.field) warnings.push('有编辑动作尚未绑定内容');
        if (['countdown','progress'].includes(layer.type) && !layer.field) warnings.push('有倒数或进度图层尚未绑定内容');
        if (layer.field && (layer.dataScope || layer.dataUrl)) warnings.push('有图层同时绑定了手填内容和动态数据，动态数据会覆盖显示');
      });
    } else {
      if (!pkg.html.trim()) warnings.push('代码模式还没有 HTML 界面');
      const used = [...pkg.script.matchAll(/EPhoneWidget\.(?:get|edit|set)\(\s*['"]([a-z][\w-]{0,39})['"]/gi)].map(match=>match[1]);
      const missing = [...new Set(used)].filter(key=>!pkg.fields.some(field=>field.key===key));
      if(missing.length) warnings.push(`脚本使用了未声明的字段：${missing.join('、')}`);
      if (/\bfetch\s*\(/.test(pkg.script) && !/EPhoneWidget\.fetch\s*\(/.test(pkg.script)) warnings.push('脚本直接调用 fetch 可能被隔离环境阻止，请使用 EPhoneWidget.fetch');
      if (/EPhoneWidget\.read\s*\(/.test(pkg.script) && !pkg.dataScopes.length) warnings.push('脚本读取应用数据，但尚未声明 dataScopes 权限');
      if (/EPhoneWidget\.fetch\s*\(/.test(pkg.script) && !pkg.networkHosts.length) warnings.push('脚本请求网络，但尚未声明 networkHosts 权限');
    }
    return [...new Set(warnings)];
  }
  function chooseImport() {
    const picker = document.createElement('input'); picker.type = 'file'; picker.accept = '.ephonewidget,.json,.html,.htm,.txt,application/json,text/html,text/plain'; picker.hidden = true;
    document.body.append(picker);
    picker.onchange = async () => { try { await importFile(picker.files?.[0]); } catch (error) { notify(`导入失败：${error.message}`); } finally { picker.remove(); } };
    picker.oncancel = () => picker.remove();
    picker.click();
  }
  function openImportHub() {
    const body = document.createElement('div'); body.className = 'cw-form';
    const note = document.createElement('p'); note.className = 'cw-note';
    note.textContent = '可以选作品文件，或粘贴 AI 返回的完整 JSON、HTML 文件内容、标明语言的 HTML/CSS/JavaScript 代码块。导入前会检查并预览。';
    const paste = document.createElement('label'); paste.className = 'cw-field'; paste.textContent = '粘贴 AI 结果';
    const area = document.createElement('textarea'); area.className = 'cw-import-text'; area.placeholder = '在这里粘贴完整 .ephonewidget JSON 或 AI 返回的代码…'; paste.append(area);
    const actions = document.createElement('div'); actions.className = 'cw-actions';
    actions.append(button('检查并预览',async()=>{try{await importFile(new File([area.value],'AI-result.txt',{type:'text/plain'}));}catch(error){notify(`导入失败：${error.message}`);}},'cw-primary'),
      button('选择文件',chooseImport),button('分别粘贴三段代码',openCodeImport),button('返回我的小组件',openLibrary));
    body.append(note,paste,actions);
    show('导入 AI 结果或作品',body);
  }
  function openCodeImport() {
    const body = document.createElement('div'); body.className = 'cw-form';
    const note = document.createElement('p'); note.className = 'cw-note';
    note.textContent = '把 AI 给出的界面、样式和逻辑分别粘贴。应用会生成可导入作品；代码里通过 EPhoneWidget 保存的内容会自动列为可编辑字段。';
    const name = document.createElement('input'); name.value = 'AI 制作的小组件'; name.setAttribute('aria-label','小组件名称');
    const named = document.createElement('label'); named.className = 'cw-field'; named.textContent='名称'; named.append(name);
    const areas = {};
    ['HTML','CSS','JavaScript'].forEach(label=>{const wrap=document.createElement('label');wrap.className='cw-field';wrap.textContent=label;const area=document.createElement('textarea');area.className='cw-import-code';wrap.append(area);areas[label]=area;body.append(wrap);});
    const actions = document.createElement('div'); actions.className = 'cw-actions';
    actions.append(button('检查并预览',async()=>{try{const html=areas.HTML.value.trim();if(!html)throw new Error('请先粘贴 HTML');const pkg=/^\s*(?:<!doctype\s+html|<html\b)/i.test(html)&&!areas.CSS.value.trim()&&!areas.JavaScript.value.trim()?htmlPackage(html,name.value):codePackage(html,areas.CSS.value,areas.JavaScript.value,name.value);await importFile(new File([JSON.stringify(pkg)],'code.ephonewidget',{type:'application/json'}));}catch(error){notify(`导入失败：${error.message}`);}},'cw-primary'),button('返回导入',openImportHub));
    body.prepend(note,named); body.append(actions);
    show('粘贴 HTML、CSS、JavaScript',body);
  }
  function exportPackage(pkg) {
    const clean = structuredClone(pkg); delete clean.updatedAt;
    const body = document.createElement('div'); body.className = 'cw-form';
    const note = document.createElement('p'); note.className = 'cw-note';
    note.textContent = `即将导出「${pkg.name}」的界面、功能、装饰图片与权限声明。${pkg.fields.length ? `接收者可填写或保存：${pkg.fields.map(field=>field.label).join('、')}。` : '此作品没有可填写项目。'}桌面实例中的个人内容不会包含在文件里。`;
    const permissions = document.createElement('p'); permissions.className = 'cw-note';
    permissions.textContent = `权限：${[pkg.dataScopes?.length ? `应用数据 ${pkg.dataScopes.join('、')}` : '',pkg.networkHosts?.length ? `联网 ${pkg.networkHosts.join('、')}` : ''].filter(Boolean).join('；') || '无额外权限'}`;
    body.append(note,permissions,button('下载 .ephonewidget 作品文件',()=>{download(`${pkg.name.replace(/[\\/:*?"<>|]/g, '_')}.ephonewidget`, JSON.stringify(clean, null, 2));openLibrary();},'cw-primary'),button('返回我的小组件',openLibrary));
    show('导出分享',body);
  }
  async function deletePackage(pkg) {
    const activeFree = (appState.globalSettings.freeHomeLayout?.pages || []).some(page => page.some(item => item.kind === 'widget' && item.key === `custom:${pkg.id}`));
    const classic = appState.globalSettings.classicCustomWidgetIds || [];
    const records = await database.customWidgetInstances.where('packageId').equals(pkg.id).toArray();
    if (activeFree || records.some(record => classic.includes(record.id))) return notify('请先从桌面移除这个小组件，再删除作品');
    if (!await window.showCustomConfirm('删除小组件', `删除「${esc(pkg.name)}」及不再使用的个人内容？`)) return;
    await database.transaction('rw', database.customWidgetPackages, database.customWidgetInstances, async () => {
      await database.customWidgetPackages.delete(pkg.id);
      await database.customWidgetInstances.where('packageId').equals(pkg.id).delete();
    });
    packages.delete(pkg.id); notify('小组件已删除'); openLibrary();
  }
  function exportAI(pkg) { openAI(pkg); }
  function openLibrary() {
    const body = document.createElement('div'); body.className = 'cw-form';
    const actions = document.createElement('div'); actions.className = 'cw-actions';
    actions.append(button('制作小组件', () => openEditor(blank()), 'cw-primary'),button('选择功能范例',openTemplates),button('让 AI 制作',()=>openAI()),button('导入小组件', chooseImport),button('粘贴 AI 结果',openImportHub), button('制作说明', openHelp));
    body.append(actions);
    if (!packages.size) { const note = document.createElement('p'); note.className = 'cw-note'; note.textContent = '还没有自制小组件。可以描述需求交给 AI、从空白制作，或导入别人分享的作品。'; body.append(note); }
    [...packages.values()].sort((a,b) => a.name.localeCompare(b.name,'zh-CN')).forEach(pkg => {
      const row = document.createElement('div'); row.className = 'cw-library-card';
      const info = document.createElement('div'); info.className = 'cw-library-info';
      const name = document.createElement('strong'); name.textContent = pkg.name;
      const note = document.createElement('span'); note.textContent = `${pkg.author || '自制'} · ${pkg.size.w}×${pkg.size.h} · ${pkg.fields.length} 项可填写内容`;
      info.append(name,note);
      if(pkg.description){const description=document.createElement('span');description.className='cw-library-description';description.textContent=pkg.description;info.append(description);}
      const tools = document.createElement('div'); tools.className = 'cw-actions';
      tools.append(button('添加到桌面', () => openPlacement(pkg)), button('编辑', () => openEditor(structuredClone(pkg))), button('复制', () => { const copy=structuredClone(pkg);copy.id=uid();copy.name=`${pkg.name} 副本`;openEditor(copy); }), button('导出', () => exportPackage(pkg)), button('交给 AI', () => exportAI(pkg)), button('删除', () => deletePackage(pkg).catch(error => notify(error.message))));
      row.append(info,tools); body.append(row);
    });
    show('我的小组件', body);
  }
  async function openPlacement(pkg) {
    const actions = document.createElement('div'); actions.className = 'cw-form';
    actions.append(button('添加到当前自由布局页面', async () => {
      try { await addFree(pkg.id, pkg.size); close(); notify('已添加到自由布局，可点击填写内容'); }
      catch (error) { notify(error.message); }
    }, 'cw-row-button'));
    show(`放置「${pkg.name}」`, actions);
  }
  function openTemplates() {
    const body = document.createElement('div'); body.className = 'cw-form';
    const note = document.createElement('p'); note.className = 'cw-note'; note.textContent = '选择有明确用途的范例，再修改功能与外观；也可以从空白开始。'; body.append(note);
    [['空白组件','从零设计界面和功能',blank],['计数器','可视化按钮加减，每个实例分别保存',counterExample],['重要日子倒数','填写日期后自动显示剩余天数',countdownExample],['每日打卡','代码模式完整交互范例',checkinExample],['相框（旧范例）','保留原有照片填写范例',example]].forEach(([name,description,create])=>{
      const row=button(`${name} · ${description}`,()=>openEditor(create()),'cw-row-button');body.append(row);
    });
    body.append(button('返回我的小组件',openLibrary));
    show('选择功能范例',body);
  }
  function openHelp() {
    const body = document.createElement('div'); body.className = 'cw-form cw-help';
    const sections = [
      ['从需求开始','先想好组件显示什么、点击后做什么，以及接收者需要填写什么。可以从空白或功能范例制作，也可以复制通用说明给任意 AI。默认让 AI 返回完整 .ephonewidget JSON。'],
      ['可视化制作','添加文字、图片、形状、按钮、时钟、日期、倒数、进度或清单图层。需要保存的值在「使用者可填写的内容」中声明，再绑定图层；图层的「点击动作」决定点击后是编辑、翻面、打开应用，还是修改数字。未连接的字段不会自动产生功能。'],
      ['代码模式','HTML 写界面，CSS 写外观，JavaScript 写交互。EPhoneWidget.get 读取当前实例字段；edit 让使用者填写；set 保存；openSettings 打开配置；openApp 打开应用；read 和 fetch 需要声明权限。保存值必须先声明字段。可打开「每日打卡」范例查看完整代码。'],
      ['导入与分享','可导入 .ephonewidget、JSON、HTML，或粘贴 AI 返回的代码。「导出」分享界面和功能，不含桌面实例里的私人照片与记录。接收者导入、预览、填写自己的内容，再添加到桌面。'],
      ['运行限制','代码在隔离页面运行，不能直接访问 EPhone 主页面；联网须使用 EPhoneWidget.fetch 并声明域名，读取应用数据须声明范围。应用关闭后不保证脚本在后台运行；这里的小组件显示在 EPhone 内部桌面。']
    ];
    sections.forEach(([title,description])=>{const heading=document.createElement('strong');heading.textContent=title;const paragraph=document.createElement('p');paragraph.textContent=description;body.append(heading,paragraph);});
    const actions=document.createElement('div');actions.className='cw-actions';actions.append(button('让 AI 制作',()=>openAI()),button('查看功能范例',openTemplates),button('导入作品',openImportHub),button('返回我的小组件',openLibrary));body.append(actions);
    show('制作说明',body);
  }
  function openPreview(pkg, values = {}, returnToEditor = null) {
    const body = document.createElement('div'); body.className = 'cw-form';
    const note = document.createElement('p'); note.className = 'cw-note';
    note.textContent = '在这里点击组件试用功能，也可以填写测试内容。预览中的内容不会保存到桌面实例。';
    const warning = document.createElement('p'); warning.className = 'cw-note cw-warning';
    const warnings = inspectPackage(pkg); warning.textContent = warnings.join('；'); warning.hidden = !warnings.length;
    const holder = document.createElement('div'); holder.className = 'cw-preview'; holder.style.aspectRatio = `${pkg.size.w}/${pkg.size.h}`; holder.style.setProperty('--cw-ratio',pkg.size.w/pkg.size.h);
    holder.append(frame(pkg,null,values,()=>openPreview(pkg,values,returnToEditor)));
    const fields = document.createElement('div'); fields.className = 'cw-form';
    pkg.fields.forEach(field=>fields.append(button(`${field.type === 'image' ? '选择' : '填写'}${field.label}${values[field.key] && field.type !== 'image' ? `：${String(values[field.key]).slice(0,24)}` : ''}`,async()=>{
      try { const answer=await editField({pkg,instanceId:null,values},field.key); if(answer!=null)openPreview(pkg,values,returnToEditor); }
      catch(error){notify(error.message);}
    },'cw-row-button')));
    const actions=document.createElement('div'); actions.className='cw-actions';
    if(returnToEditor)actions.append(button('返回编辑',returnToEditor));
    actions.append(button('重置测试内容',()=>openPreview(pkg,{},returnToEditor)));
    body.append(note,warning,holder,fields,actions);
    show('预览小组件',body);
  }
  function openEditor(initial) {
    const pkg = structuredClone(initial);
    let selected = pkg.layers[0]?.id || null;
    let editorSide = 'front';
    const newFieldDraft = {name:'',type:'text'};
    let newFieldName;
    const body = document.createElement('div'); body.className = 'cw-editor';
    const meta = document.createElement('div'); meta.className = 'cw-editor-meta';
    const stage = document.createElement('div'); stage.className = 'cw-stage';
    const panel = document.createElement('div'); panel.className = 'cw-form cw-editor-panel';
    const toolbar = document.createElement('div'); toolbar.className = 'cw-actions';
    const fieldPanel = document.createElement('div'); fieldPanel.className = 'cw-form cw-editor-panel';
    const code = document.createElement('div'); code.className = 'cw-code';
    const render = () => {
      meta.replaceChildren(input('名称',pkg.name,value=>pkg.name=value),input('作者',pkg.author,value=>pkg.author=value),input('功能说明（导入时展示）',pkg.description||'',value=>pkg.description=value));
      const size = document.createElement('div'); size.className = 'cw-actions';
      size.append(input('宽度格数',pkg.size.w,value=>{pkg.size.w=Number(value);render();},'number'),input('高度格数',pkg.size.h,value=>{pkg.size.h=Number(value);render();},'number'));
      meta.append(size);
      stage.style.aspectRatio = `${Math.max(1, Math.min(4, pkg.size.w || 2))}/${Math.max(1, Math.min(4, pkg.size.h || 2))}`;
      stage.style.setProperty('--cw-ratio',Math.max(1, Math.min(4, pkg.size.w || 2))/Math.max(1, Math.min(4, pkg.size.h || 2)));
      stage.replaceChildren();
      pkg.layers.filter(layer => (layer.side || 'front') === editorSide).forEach(layer => {
        const node = document.createElement('button'); node.type='button'; node.className = `cw-stage-layer ${selected === layer.id ? 'selected' : ''}`;
        Object.assign(node.style,{left:`${layer.x}%`,top:`${layer.y}%`,width:`${layer.w}%`,height:`${layer.h}%`,background:layer.color,color:layer.textColor||'#29242a',borderRadius:`${layer.radius}px`,fontSize:`${layer.fontSize}px`});
        if (layer.type === 'image' && layer.src) { const img=document.createElement('img');img.src=layer.src;img.alt='';node.append(img); }
        else node.textContent = layer.type === 'image' ? `▧ ${layer.field || '图片'}` : layer.type === 'shape' ? '' : layer.text || layer.type;
        node.onclick = () => { selected=layer.id; render(); };
        node.addEventListener('pointerdown',event => {
          if (event.pointerType === 'mouse' && event.button !== 0) return;
          selected=layer.id; const bounds=stage.getBoundingClientRect(), startX=event.clientX, startY=event.clientY, x=layer.x, y=layer.y;
          node.setPointerCapture(event.pointerId);
          node.onpointermove = e => { if (e.pointerId !== event.pointerId) return; layer.x=Math.max(0,Math.min(100-layer.w,x+(e.clientX-startX)/bounds.width*100)); layer.y=Math.max(0,Math.min(100-layer.h,y+(e.clientY-startY)/bounds.height*100)); node.style.left=`${layer.x}%`; node.style.top=`${layer.y}%`; };
          node.onpointerup = () => { node.onpointermove=null; renderPanel(); };
        });
        stage.append(node);
      });
      renderPanel();
      toolbar.replaceChildren();
      toolbar.append(button(`当前：${editorSide === 'front' ? '正面' : '背面'}（点击切换）`,()=>{editorSide=editorSide==='front'?'back':'front';selected=pkg.layers.find(layer=>(layer.side||'front')===editorSide)?.id||null;render();}));
      [['形状','shape'],['文字','text'],['图片','image'],['按钮','button'],['时钟','clock'],['日期','date'],['倒数','countdown'],['进度','progress'],['清单','list']].forEach(([label,type]) => toolbar.append(button(`＋${label}`,()=>{const layer={id:uid(),type,side:editorSide,x:10,y:10,w:60,h:30,color:'#fff9f4',radius:10,fontSize:16,text:label,field:'',maxValue:100};pkg.layers.push(layer);selected=layer.id;render();})));
      toolbar.append(button('＋可填写内容',()=>{fieldPanel.scrollIntoView({block:'nearest'});newFieldName?.focus();}));
      fieldPanel.replaceChildren(Object.assign(document.createElement('strong'),{textContent:'使用者可填写或组件保存的内容'}));
      const explanation=document.createElement('p');explanation.className='cw-note';explanation.textContent='这里声明要保存的值；再把它绑定到图层，或在代码模式调用 EPhoneWidget.get、edit、set。只添加一行不会自动产生功能。';fieldPanel.append(explanation);
      const creator=document.createElement('div');creator.className='cw-field-creator';
      newFieldName=document.createElement('input');newFieldName.placeholder='内容名称，例如：目标日期';newFieldName.setAttribute('aria-label','新内容名称');newFieldName.value=newFieldDraft.name;newFieldName.oninput=()=>newFieldDraft.name=newFieldName.value;
      const newFieldType=document.createElement('select');newFieldType.setAttribute('aria-label','新内容类型');[['text','文字'],['number','数字'],['date','日期'],['image','图片']].forEach(([value,label])=>newFieldType.append(new Option(label,value)));newFieldType.value=newFieldDraft.type;newFieldType.onchange=()=>newFieldDraft.type=newFieldType.value;
      creator.append(newFieldName,newFieldType,button('添加内容',addField));fieldPanel.append(creator);
      pkg.fields.forEach(field => {
        const row=document.createElement('div');row.className='cw-field-card';
        const top=document.createElement('div');top.className='cw-field-row';
        const name=document.createElement('input');name.value=field.label;name.setAttribute('aria-label','内容名称');name.onchange=()=>{field.label=name.value.trim().slice(0,50)||field.key;};
        const kind=document.createElement('select');kind.setAttribute('aria-label',`${field.label}的内容类型`);[['text','文字'],['number','数字'],['date','日期'],['image','图片']].forEach(([value,label])=>kind.append(new Option(label,value)));kind.value=field.type;kind.onchange=()=>{field.type=kind.value;render();};
        top.append(name,kind,button('删除',()=>{pkg.fields=pkg.fields.filter(item=>item!==field);pkg.layers.forEach(layer=>{if(layer.field===field.key)layer.field='';if(layer.actionField===field.key)layer.actionField='';if(layer.visibleField===field.key)layer.visibleField='';});render();}));
        const detail=document.createElement('span');detail.className='cw-note';detail.textContent=`字段 ${field.key} · ${pkg.layers.some(layer=>layer.field===field.key||layer.actionField===field.key||layer.visibleField===field.key)?'已连接图层':'尚未连接图层；代码模式可直接使用'}`;
        const defaultInput=input('默认内容（每个新放置的实例）',field.defaultValue||'',value=>field.defaultValue=value,field.type==='number'?'number':field.type==='date'?'date':'text');
        if(field.type==='image')defaultInput.hidden=true;
        row.append(top,detail,defaultInput);fieldPanel.append(row);
      });
      code.hidden = pkg.mode !== 'code';
      stage.hidden = pkg.mode === 'code'; toolbar.hidden = pkg.mode === 'code'; panel.hidden = pkg.mode === 'code';
    };
    const renderPanel = () => {
      panel.replaceChildren();
      const layer = pkg.layers.find(item => item.id === selected);
      if (!layer) { panel.textContent='选择图层后可设置外观和内容。'; return; }
      panel.append(Object.assign(document.createElement('strong'),{textContent:`编辑${layer.type}图层`}));
      const sideWrap=document.createElement('label');sideWrap.className='cw-field';sideWrap.textContent='显示在';
      const sideSelect=document.createElement('select');sideSelect.append(new Option('正面','front'),new Option('背面','back'));
      sideSelect.value=layer.side||'front';sideSelect.onchange=()=>{layer.side=sideSelect.value;editorSide=sideSelect.value;render();};sideWrap.append(sideSelect);panel.append(sideWrap);
      [['横向位置','x'],['纵向位置','y'],['宽度','w'],['高度','h'],['圆角','radius'],['字号','fontSize']].forEach(([label,key]) => panel.append(input(label,Math.round(layer[key]),value=>{layer[key]=Number(value);render();},'number')));
      panel.append(input('颜色',layer.color,value=>{layer.color=value;render();},'color'));
      if (layer.type !== 'shape' && layer.type !== 'image') panel.append(input('文字颜色',layer.textColor||'#29242a',value=>{layer.textColor=value;render();},'color'));
      if (['text','button'].includes(layer.type)) panel.append(input('显示文字',layer.text,value=>{layer.text=value;render();}));
      if (['text','image','button','countdown','progress','list'].includes(layer.type)) {
        const wrap=document.createElement('label');wrap.className='cw-field';wrap.textContent='绑定可填写内容';
        const select=document.createElement('select');
        select.append(new Option('不绑定',''));
        pkg.fields.filter(field=>layer.type === 'image' ? field.type === 'image' : layer.type === 'countdown' ? field.type === 'date' : layer.type === 'progress' ? field.type === 'number' : layer.type === 'list' ? field.type === 'text' : field.type !== 'image').forEach(field=>select.append(new Option(`${field.label}（${field.type}）`,field.key)));
        select.value=layer.field||'';select.onchange=()=>{layer.field=select.value;render();};wrap.append(select);panel.append(wrap);
      }
      if(layer.type==='progress')panel.append(input('进度目标值',layer.maxValue||100,value=>{layer.maxValue=Number(value);render();},'number'));
      const condition=document.createElement('label');condition.className='cw-field';condition.textContent='只在某项内容等于指定值时显示（可选）';
      const conditionField=document.createElement('select');conditionField.append(new Option('始终显示',''));pkg.fields.filter(field=>field.type!=='image').forEach(field=>conditionField.append(new Option(field.label,field.key)));
      conditionField.value=layer.visibleField||'';conditionField.onchange=()=>{layer.visibleField=conditionField.value;render();};condition.append(conditionField);panel.append(condition);
      if(layer.visibleField)panel.append(input('显示时该内容的值',layer.visibleValue??'',value=>{layer.visibleValue=value;render();}));
      if (layer.type === 'text') {
        const sourceWrap=document.createElement('label');sourceWrap.className='cw-field';sourceWrap.textContent='动态数据';
        const sourceSelect=document.createElement('select');
        [['','无'],['todoCount','当前角色今日待办数'],['musicStatus','音乐状态'],['external','外部 HTTPS 数据']].forEach(([key,label])=>sourceSelect.append(new Option(label,key)));
        sourceSelect.value=layer.dataScope|| (layer.dataUrl ? 'external' : '');
        sourceSelect.onchange=()=>{layer.dataScope=sourceSelect.value==='external'?'':sourceSelect.value;if(sourceSelect.value!=='external')layer.dataUrl='';render();};
        sourceWrap.append(sourceSelect);panel.append(sourceWrap);
        if(sourceSelect.value==='external') {
          panel.append(input('HTTPS 数据地址',layer.dataUrl||'',value=>{try{const url=new URL(value);if(url.protocol!=='https:')throw Error();layer.dataUrl=url.href;pkg.networkHosts ||= [];if(!pkg.networkHosts.includes(url.hostname))pkg.networkHosts.push(url.hostname);}catch(_){layer.dataUrl='';notify('请输入 HTTPS 地址');}render();},'url'));
          panel.append(input('JSON 字段路径（可空）',layer.dataPath||'',value=>{layer.dataPath=value;render();}));
        }
      }
      if (layer.type === 'image') panel.append(button('上传装饰图片',async()=>{const value=await pickImage(500,1,'image/png');if(!value)return;if(value.length>350000)return notify('装饰图片过大，请选择更简单的图片');layer.src=value;render();}));
      const actionWrap=document.createElement('label');actionWrap.className='cw-field';actionWrap.textContent='点击动作';
      const actionSelect=document.createElement('select');
      [['','无'],['edit','编辑绑定的内容'],['increment','数字加一'],['decrement','数字减一'],['reset','数字归零'],['toggle','切换 0 / 1'],['flip','翻转组件'],['settings','打开填写菜单'],['app','打开 EPhone 应用']].forEach(([key,label])=>actionSelect.append(new Option(label,key)));
      actionSelect.value=layer.interaction===undefined?(layer.field?'edit':layer.action||''):layer.interaction;
      actionSelect.onchange=()=>{layer.interaction=actionSelect.value;render();};actionWrap.append(actionSelect);panel.append(actionWrap);
      if (actionSelect.value === 'edit' && !layer.field) {const hint=document.createElement('p');hint.className='cw-note cw-warning';hint.textContent='先把此图层绑定到一个可填写内容，点击后才会打开填写界面。';panel.append(hint);}
      if (['increment','decrement','reset','toggle'].includes(actionSelect.value)) {
        const wrap=document.createElement('label');wrap.className='cw-field';wrap.textContent='点击后修改哪个内容';
        const target=document.createElement('select');target.append(new Option('请选择',''));pkg.fields.filter(field=>field.type==='number'||(actionSelect.value==='toggle'&&field.type==='text')).forEach(field=>target.append(new Option(field.label,field.key)));
        target.value=layer.actionField||'';target.onchange=()=>{layer.actionField=target.value;render();};wrap.append(target);panel.append(wrap);
      }
      if (actionSelect.value === 'app') panel.append(input('应用 ID',layer.appKey||'',value=>{layer.appKey=value.trim();render();}));
      panel.append(button('删除此图层',()=>{pkg.layers=pkg.layers.filter(item=>item.id!==layer.id);selected=pkg.layers.find(item=>(item.side||'front')===editorSide)?.id||null;render();}));
    };
    const addField = () => {
      if (pkg.fields.length >= 30) return notify('最多添加 30 项可填写内容');
      const name=newFieldDraft.name.trim();if(!name){newFieldName?.focus();return notify('请先填写内容名称');}
      const key=`field${uid().replace(/[^a-z0-9]/gi,'').slice(0,12)}`;
      pkg.fields.push({key,label:name.slice(0,50),type:newFieldDraft.type,defaultValue:''});newFieldDraft.name='';render();
    };
    const switcher=document.createElement('div');switcher.className='cw-actions';
    switcher.append(button('可视化画布',()=>{pkg.mode='visual';render();}),button('代码模式',()=>{pkg.mode='code';render();}));
    const codeNote=document.createElement('p');codeNote.className='cw-note';codeNote.textContent='HTML 写界面，CSS 写外观，JavaScript 写交互。需要保存的值先在下方声明字段，再用 EPhoneWidget.get、edit、set；联网和应用数据要声明权限。完整范例可从「选择功能范例 → 每日打卡」打开。';code.append(codeNote);
    code.append(button('查看完整代码范例',()=>{const sample=checkinExample();const details=document.createElement('div');details.className='cw-form';const introduction=document.createElement('p');introduction.className='cw-note';introduction.textContent='每日打卡示例声明 days 数字字段和 lastDay 日期字段，点击后保存当前桌面实例的记录。';details.append(introduction);[['HTML',sample.html],['CSS',sample.css],['JavaScript',sample.script]].forEach(([label,value])=>{const wrap=document.createElement('label');wrap.className='cw-field';wrap.textContent=label;const area=document.createElement('textarea');area.value=value;area.readOnly=true;wrap.append(area);details.append(wrap);});details.append(button('返回编辑',()=>show('制作小组件',body)));show('代码模式完整范例',details);},'cw-row-button'));
    ['html','css','script'].forEach(key=>{
      const label=document.createElement('label');label.className='cw-field';
      label.append(Object.assign(document.createElement('span'),{textContent:{html:'HTML',css:'CSS',script:'JavaScript'}[key]}));
      const area=document.createElement('textarea');area.value=pkg[key];area.onchange=()=>pkg[key]=area.value;
      label.append(area);code.append(label);
    });
    code.append(input('可读取的应用数据（todoCount、musicStatus，逗号分隔）',(pkg.dataScopes||[]).join(', '),value=>{pkg.dataScopes=value.split(/[,，\s]+/).filter(Boolean);}),
      input('联网域名（不含 https://，逗号分隔）',(pkg.networkHosts||[]).join(', '),value=>{pkg.networkHosts=value.split(/[,，\s]+/).filter(Boolean);}));
    const foot=document.createElement('div');foot.className='cw-actions';
    const saveEditor=async()=>{try{const valid=await putPackage(pkg,true);notify(`已保存「${valid.name}」`);openLibrary();}catch(error){notify(error.message);}};
    const checkAndSave=()=>{try{const warnings=inspectPackage(validate(pkg));if(!warnings.length)return saveEditor();const notice=document.createElement('div');notice.className='cw-form';const message=document.createElement('p');message.className='cw-note cw-warning';message.textContent=`保存前请检查：${warnings.join('；')}。`;const actions=document.createElement('div');actions.className='cw-actions';actions.append(button('返回修改',()=>show('制作小组件',body)),button('仍然保存',saveEditor,'cw-primary'));notice.append(message,actions);show('保存前检查',notice);}catch(error){notify(error.message);}};
    foot.append(button('预览并试用',()=>{try{openPreview(validate(pkg),{},()=>show('制作小组件',body));}catch(error){notify(error.message);}}),
      button('保存到我的小组件',checkAndSave,'cw-primary'));
    body.append(meta,switcher,stage,toolbar,panel,fieldPanel,code,foot);
    render(); show('制作小组件',body);
  }
  async function init(options) {
    database=options.db; appState=options.state; addFree=options.addFree; openApp=options.openApp; notify=options.notify;
    (await database.customWidgetPackages.toArray()).forEach(pkg=>packages.set(pkg.id,pkg));
    overlay=document.createElement('div');overlay.id='custom-widget-overlay';overlay.hidden=true;
    overlay.innerHTML='<div class="cw-dialog"><header><strong class="cw-title"></strong><button type="button" class="cw-close" aria-label="关闭">×</button></header><main class="cw-body"></main></div>';
    overlay.querySelector('.cw-close').onclick=close;
    overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
    document.getElementById('phone-screen').append(overlay);
    window.addEventListener('message',onMessage);
  }
  return { init, openLibrary, packagesForLayout, installLayoutPackages, freshenLayoutInstances, cleanupOrphans, has:id=>packages.has(id), get:id=>packages.get(id), mount, openInstanceSettings:async(packageId,instanceId)=>{const pkg=packages.get(packageId);if(!pkg)return notify('小组件未安装');const record=await database.customWidgetInstances.get(instanceId);openInstanceSettings({pkg,instanceId,values:record?.values||{}},()=>{document.querySelectorAll(`[data-custom-instance="${CSS.escape(instanceId)}"]`).forEach(node=>mount(packageId,instanceId,node));});} };
})();
