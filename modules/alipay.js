// ========================================
// 支付宝模块
// 来源: script.js 第 60163 ~ 60700 行
// 包含: openAlipayScreen, renderTransactionList, initBillListUI, bindBillEvents,
//       loadBills, renderBillItems, handleUserTopUp, openKinshipSelector, sendKinshipRequest
// ========================================

  const BLACK_GOLD_THRESHOLD = 10000;

  let selectedKinshipCharId = null;

  async function openAlipayScreen() {
    await initUserWallet();

    const balanceEl = document.getElementById('alipay-balance-display');
    if (balanceEl) {
      const safeBalance = isNaN(window.userBalance) ? 0 : window.userBalance;
      balanceEl.textContent = safeBalance.toFixed(2);
    }

    const alipayScreen = document.getElementById('alipay-screen');
    const statusTag = document.getElementById('alipay-status-tag');

    if (window.userBalance >= BLACK_GOLD_THRESHOLD) {
      alipayScreen.classList.add('theme-blackgold');
      if (statusTag) statusTag.textContent = '黑金会员';
    } else {
      alipayScreen.classList.remove('theme-blackgold');
      if (statusTag) statusTag.textContent = '标准会员';
    }

    const oldWrapper = document.getElementById('alipay-kinship-section-wrapper');
    if (oldWrapper) oldWrapper.remove();
    const container = document.querySelector('.alipay-card-container');
    const wallet = await db.userWallet.get('main');
    const kinshipCards = wallet?.kinshipCards || [];

    const kinshipWrapper = document.createElement('div');
    kinshipWrapper.id = 'alipay-kinship-section-wrapper';
    kinshipWrapper.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; padding: 0 5px;">
            <span class="kinship-section-title">亲属卡 / 亲密付</span>
            <span id="add-kinship-btn" style="font-size:22px; color:#1677ff; cursor:pointer; line-height:1;">+</span>
        </div>
    `;
    const scrollContainer = document.createElement('div');
    scrollContainer.id = 'alipay-kinship-section';

    if (kinshipCards.length === 0) {
      scrollContainer.innerHTML = `
            <div class="kinship-empty-state" style="background:white; width:100%; border-radius:12px; padding:20px; text-align:center; color:#999; box-shadow:0 2px 8px rgba(0,0,0,0.03);">
                <p style="margin:0; font-size:13px;">暂无亲属卡，快去邀请TA吧</p>
            </div>`;
    } else {
      kinshipCards.forEach(card => {
        const chat = state.chats[card.chatId];
        const providerName = chat ? chat.name : '未知角色';
        const providerAvatar = chat ? (chat.settings.aiAvatar || defaultAvatar) : defaultAvatar;
        const remaining = card.limit - (card.spent || 0);
        const isInCard = card.type === 'in';
        const directionLabel = isInCard ? 'TA给我' : '我给TA';
        const visibilityText = isInCard ? '我的消费对方可见' : '对方消费我可见';

        const cardGradient = isInCard
          ? 'linear-gradient(135deg, #4f8cff 0%, #35cfd0 100%)'
          : 'linear-gradient(135deg, #ff9fbc 0%, #ff78ab 100%)';

        const cardTextColor = isInCard ? '#eaf8ff' : '#ffe66b';

        const cardEl = document.createElement('div');
        cardEl.className = 'kinship-card-entry';
        cardEl.style.background = cardGradient;
        cardEl.style.color = cardTextColor;
        cardEl.innerHTML = `
                <button class="alipay-unbind-btn" data-chat-id="${card.chatId}">解绑</button>
                <div class="kinship-top">
                    <div class="kinship-provider">
                        <img src="${providerAvatar}">
                        <span>${providerName} (${directionLabel})</span>
                    </div>
                    <span style="font-size:11px; opacity:0.8;">${visibilityText}</span>
                </div>
                <div class="kinship-label">本月剩余额度</div>
                <div class="kinship-limit">¥ ${remaining.toFixed(2)}</div>
            `;
        scrollContainer.appendChild(cardEl);
      });
    }

    kinshipWrapper.appendChild(scrollContainer);
    container.appendChild(kinshipWrapper);

    const addBtn = kinshipWrapper.querySelector('#add-kinship-btn');
    if (addBtn) addBtn.onclick = openKinshipSelector;

    if (typeof initBillListUI === 'function') {
      await initBillListUI();
    }

    showScreen('alipay-screen');
  }

  async function renderTransactionList() {
    const alipayScreen = document.getElementById('alipay-screen');
    if (alipayScreen && alipayScreen.classList.contains('active')) {
      await loadBills(true);
    }
  }

  async function initBillListUI() {
    const container = document.getElementById('alipay-transaction-list');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.height = '100%';
    container.style.overflow = 'hidden';
    container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'bill-filter-header';
    header.innerHTML = `
        <div class="bill-date-picker-wrapper">
            <input type="month" id="bill-date-input" class="bill-date-input" value="${billState.filterDate}">
        </div>
        <div class="bill-type-tabs">
            <span class="bill-type-tab active" data-type="all">全部</span>
            <span class="bill-type-tab" data-type="expense">支出</span>
            <span class="bill-type-tab" data-type="income">收入</span>
        </div>
    `;
    container.appendChild(header);

    const scrollList = document.createElement('div');
    scrollList.id = 'bill-scroll-list';
    container.appendChild(scrollList);

    const loader = document.createElement('div');
    loader.id = 'bill-loader';
    loader.className = 'bill-loading-more hidden';
    loader.textContent = '正在加载更多...';
    scrollList.appendChild(loader);

    bindBillEvents();
    await loadBills(true);
  }

  function bindBillEvents() {
    const dateInput = document.getElementById('bill-date-input');
    dateInput.addEventListener('change', (e) => {
      billState.filterDate = e.target.value;
      loadBills(true);
    });

    const tabs = document.querySelectorAll('.bill-type-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        tabs.forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');
        billState.filterType = e.target.dataset.type;
        loadBills(true);
      });
    });

    const scrollList = document.getElementById('bill-scroll-list');
    scrollList.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollList;
      if (scrollHeight - scrollTop <= clientHeight + 50) {
        if (billState.hasMore && !billState.isLoading) {
          loadBills(false);
        }
      }
    });
  }

  async function loadBills(isReset = false) {
    if (billState.isLoading) return;

    const scrollList = document.getElementById('bill-scroll-list');
    const loader = document.getElementById('bill-loader');

    billState.isLoading = true;
    loader.classList.remove('hidden');

    if (isReset) {
      billState.page = 0;
      billState.hasMore = true;
      const items = scrollList.querySelectorAll('.bill-item, .bill-month-separator, .bill-empty-msg');
      items.forEach(el => el.remove());
      scrollList.scrollTop = 0;
    }

    try {
      let collection = db.userTransactions.orderBy('timestamp').reverse();
      let allMatches = await collection.toArray();

      if (billState.filterType !== 'all') {
        allMatches = allMatches.filter(t => t.type === billState.filterType);
      }

      if (billState.filterDate) {
        const [year, month] = billState.filterDate.split('-');
        allMatches = allMatches.filter(t => {
          const d = new Date(t.timestamp);
          return d.getFullYear() === parseInt(year) && (d.getMonth() + 1) === parseInt(month);
        });
      }

      const start = billState.page * billState.pageSize;
      const end = start + billState.pageSize;
      const pageData = allMatches.slice(start, end);

      if (pageData.length < billState.pageSize) {
        billState.hasMore = false;
        loader.textContent = '— 没有更多记录了 —';
        loader.classList.remove('hidden');
      } else {
        loader.textContent = '加载中...';
      }

      if (pageData.length === 0 && isReset) {
        scrollList.insertAdjacentHTML('afterbegin',
          '<div class="bill-empty-msg" style="text-align:center; padding:40px; color:#999;">暂无相关账单</div>'
        );
      } else {
        renderBillItems(pageData, scrollList, loader);
      }

      billState.page++;

    } catch (error) {
      console.error("加载账单失败:", error);
      loader.textContent = '加载失败';
    } finally {
      billState.isLoading = false;
      if (billState.hasMore) loader.classList.add('hidden');
    }
  }

  function renderBillItems(transactions, container, loaderEl) {
    let lastMonthStr = '';
    const existingSeparators = container.querySelectorAll('.bill-month-separator');
    if (existingSeparators.length > 0) {
      lastMonthStr = existingSeparators[existingSeparators.length - 1].textContent;
    }

    const fragment = document.createDocumentFragment();

    transactions.forEach(t => {
      let safeAmount = Number(t.amount);
      if (isNaN(safeAmount)) {
        console.warn("检测到异常账单数据 (金额无效):", t);
        safeAmount = 0;
      }

      const date = new Date(t.timestamp);
      const monthStr = `${date.getFullYear()}年${date.getMonth() + 1}月`;

      if (monthStr !== lastMonthStr) {
        const separator = document.createElement('div');
        separator.className = 'bill-month-separator';
        separator.textContent = monthStr;
        fragment.appendChild(separator);
        lastMonthStr = monthStr;
      }

      const timeStr = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      const isIncome = t.type === 'income';
      const sign = isIncome ? '+' : '-';
      const colorClass = isIncome ? 'income' : 'expense';

      const item = document.createElement('div');
      item.className = 'bill-item';
      item.innerHTML = `
            <div class="bill-info">
                <div class="bill-title">${t.description || '未知交易'}</div>
                <div class="bill-time">${timeStr}</div>
            </div>
            <div class="bill-amount ${colorClass}">${sign}${safeAmount.toFixed(2)}</div>
        `;
      fragment.appendChild(item);
    });

    container.insertBefore(fragment, loaderEl);
  }

  async function handleUserTopUp() {
    const amountStr = await showCustomPrompt("充值", "请输入充值金额 (CNY):", "", "number");
    if (!amountStr) return;

    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      alert("请输入有效的金额");
      return;
    }

    await processTransaction(amount, 'income', '余额充值');
    openAlipayScreen();
    await showCustomAlert("充值成功", `成功充值 ¥${amount.toFixed(2)}`);
  }

  async function openKinshipSelector() {
    const characters = Object.values(state.chats).filter(c => !c.isGroup);
    if (characters.length === 0) return alert("没有可绑定的角色");

    const modal = document.getElementById('kinship-creation-modal');
    const listEl = document.getElementById('kinship-char-list');
    const limitInput = document.getElementById('kinship-limit-input');

    let typeContainer = document.getElementById('kinship-type-container');
    if (!typeContainer) {
      typeContainer = document.createElement('div');
      typeContainer.id = 'kinship-type-container';
      typeContainer.style.cssText = "margin-bottom: 15px; display: flex; gap: 10px; justify-content: center;";
      const inputGroup = limitInput.parentElement;
      inputGroup.parentElement.insertBefore(typeContainer, inputGroup);
    }

    typeContainer.innerHTML = `
        <label class="radio-btn-wrapper" style="flex:1;">
            <input type="radio" name="kinship-type" value="grant" checked>
            <div class="radio-btn-content" style="text-align:center; padding:10px; border:1px solid #ddd; border-radius:8px; cursor:pointer;">
                <div style="font-weight:bold; color:#ff5252;">我送TA</div>
                <div style="font-size:12px; color:#666;">(花我的钱)</div>
            </div>
        </label>
        <label class="radio-btn-wrapper" style="flex:1;">
            <input type="radio" name="kinship-type" value="request">
            <div class="radio-btn-content" style="text-align:center; padding:10px; border:1px solid #ddd; border-radius:8px; cursor:pointer;">
                <div style="font-weight:bold; color:#1677ff;">问TA要</div>
                <div style="font-size:12px; color:#666;">(花TA的钱)</div>
            </div>
        </label>
    `;

    const radios = typeContainer.querySelectorAll('input[name="kinship-type"]');
    const updateStyles = () => {
      radios.forEach(radio => {
        const content = radio.nextElementSibling;
        if (radio.checked) {
          content.style.borderColor = radio.value === 'grant' ? '#ff5252' : '#1677ff';
          content.style.backgroundColor = radio.value === 'grant' ? '#fff0f0' : '#f0f7ff';
        } else {
          content.style.borderColor = '#ddd';
          content.style.backgroundColor = '#fff';
        }
      });
    };
    radios.forEach(r => r.addEventListener('change', updateStyles));
    updateStyles();

    listEl.innerHTML = '';
    selectedKinshipCharId = null;
    limitInput.value = '';

    characters.forEach(char => {
      const item = document.createElement('div');
      item.className = 'clear-posts-item';
      item.dataset.id = char.id;

      item.onclick = () => {
        listEl.querySelectorAll('.clear-posts-item').forEach(el => {
          el.classList.remove('selected');
          const cb = el.querySelector('.checkbox');
          if (cb) cb.classList.remove('selected');
        });
        item.classList.add('selected');
        const cb = item.querySelector('.checkbox');
        cb.classList.add('selected');
        selectedKinshipCharId = char.id;
      };

      const avatar = char.settings.aiAvatar || defaultAvatar;
      item.innerHTML = `
            <div class="checkbox" style="pointer-events: none;"></div>
            <img src="${avatar}" style="width: 40px; height: 40px; border-radius: 50%; margin-right: 10px; object-fit: cover;">
            <span class="name" style="font-weight: 500; font-size: 16px;">${char.name}</span>
        `;
      listEl.appendChild(item);
    });

    modal.classList.add('visible');
  }

  async function sendKinshipRequest(chatId, limit, type = 'grant') {
    const chat = state.chats[chatId];
    const myNickname = chat.settings.myNickname || '我';

    let userContentText = "";
    if (type === 'grant') {
      userContentText = `[我为你开通了"亲属卡"，每月额度 ¥${limit}]`;
    } else {
      userContentText = `[我向你发起了"亲属卡"代付申请，每月额度 ¥${limit}]`;
    }

    const userMsg = {
      role: 'user',
      type: 'kinship_request',
      content: userContentText,
      limit: limit,
      status: 'pending',
      requestType: type,
      timestamp: Date.now()
    };
    chat.history.push(userMsg);

    let systemContentText = "";
    if (type === 'grant') {
      systemContentText = `[系统提示：用户(${myNickname})为你开通了支付宝"亲属卡"（亲密付），每月额度 ¥${limit}。这意味着你的消费将由用户买单。请根据你们的关系决定接受还是拒绝。请使用 'kinship_response' 指令进行回应。]`;
    } else {
      systemContentText = `[系统提示：用户(${myNickname})向你申请开通支付宝"亲属卡"（亲密付），每月额度 ¥${limit}。这意味着用户的消费将由你买单。请根据你的经济状况和对用户的宠爱程度，决定接受还是拒绝。请使用 'kinship_response' 指令进行回应。]`;
    }

    const systemMsg = {
      role: 'system',
      content: systemContentText,
      timestamp: Date.now() + 1,
      isHidden: true
    };
    chat.history.push(systemMsg);

    await db.chats.put(chat);

    if (state.activeChatId === chatId) {
      appendMessage(userMsg, chat);
      triggerAiResponse();
    } else {
      openChat(chatId);
    }
  }

  // ========================================
  // 基金模块
  // 来源: script.js 第 60674 ~ 61059 行
  // 包含: checkThemeStatus, simulateFundMarket, openFundScreen, renderFundScreen,
  //       generateMiniChartSvg, renderFundMarketList, renderFundMyList, switchFundTab,
  //       openFundTradeModal, handleFundTradeConfirm
  // ========================================

  // 全局主题检查 (核心：余额变动自动切换黑金/蓝色)
  function checkThemeStatus() {
    const threshold = 10000;
    const isGold = window.userBalance >= threshold;

    const screens = ['alipay-screen', 'fund-screen'];
    screens.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        if (isGold) {
          el.classList.add('theme-blackgold');
        } else {
          el.classList.remove('theme-blackgold');
        }
      }
    });

    const statusTag = document.getElementById('alipay-status-tag');
    if (statusTag) {
      if (isGold) {
        statusTag.textContent = '黑金会员';
        statusTag.style.color = '#d4af37';
        statusTag.style.borderColor = '#d4af37';
      } else {
        statusTag.textContent = '标准会员';
        statusTag.style.color = 'white';
        statusTag.style.borderColor = 'white';
      }
    }
    const balanceDisplay = document.getElementById('alipay-balance-display');
    if (balanceDisplay) balanceDisplay.textContent = window.userBalance.toFixed(2);
  }

  // 模拟市场波动 (升级版：记录历史走势)
  async function simulateFundMarket() {
    const funds = await db.funds.toArray();
    const updates = [];

    const marketSentiment = (Math.random() - 0.45) * 0.05;

    for (const fund of funds) {
      if (!fund.history || fund.history.length === 0) {
        fund.history = [];
        let mockNav = fund.currentNav;
        for (let i = 0; i < 15; i++) {
          mockNav = mockNav * (1 - (Math.random() - 0.5) * 0.02);
          fund.history.unshift(parseFloat(mockNav.toFixed(4)));
        }
      }

      let volatility = 0.01;
      if (fund.riskLevel === 'medium') volatility = 0.03;
      if (fund.riskLevel === 'high') volatility = 0.06;

      const individualChange = (Math.random() - 0.5) * volatility;
      const changePercent = marketSentiment + individualChange;

      if (fund.history.length >= 20) fund.history.shift();
      fund.history.push(fund.currentNav);

      const oldNav = fund.currentNav;
      let newNav = oldNav * (1 + changePercent);
      if (newNav < 0.1) newNav = 0.1;

      fund.lastDayNav = oldNav;
      fund.currentNav = parseFloat(newNav.toFixed(4));

      updates.push(fund);
    }
    await db.funds.bulkPut(updates);
  }

  // 打开基金页面
  async function openFundScreen() {
    await simulateFundMarket();
    checkThemeStatus();
    await renderFundScreen();
    showScreen('fund-screen');
  }

  // 渲染基金主界面
  let activeFundTab = 'market';

  async function renderFundScreen() {
    const funds = await db.funds.toArray();
    const wallet = await db.userWallet.get('main');
    const holdings = wallet.fundHoldings || [];

    let totalAssets = 0;
    let totalProfit = 0;
    let yesterdayProfit = 0;

    holdings.forEach(h => {
      const fund = funds.find(f => f.id === h.fundId);
      if (fund) {
        const marketValue = h.units * fund.currentNav;
        const costValue = h.units * h.cost;
        const yesterdayValue = h.units * fund.lastDayNav;

        totalAssets += marketValue;
        totalProfit += (marketValue - costValue);
        yesterdayProfit += (marketValue - yesterdayValue);
      }
    });

    document.getElementById('fund-total-assets').textContent = totalAssets.toFixed(2);

    const totalProfitEl = document.getElementById('fund-total-profit');
    totalProfitEl.textContent = (totalProfit >= 0 ? "+" : "") + totalProfit.toFixed(2);
    totalProfitEl.style.color = totalProfit >= 0 ? '#ff9c9c' : '#a0f0a0';

    const yesterdayProfitEl = document.getElementById('fund-yesterday-profit');
    yesterdayProfitEl.textContent = (yesterdayProfit >= 0 ? "+" : "") + yesterdayProfit.toFixed(2);

    if (activeFundTab === 'market') {
      renderFundMarketList(funds);
    } else {
      renderFundMyList(funds, holdings);
    }
  }

  // 辅助函数：生成迷你走势图 SVG
  function generateMiniChartSvg(dataPoints, isUp) {
    if (!dataPoints || dataPoints.length < 2) return '';

    const width = 60;
    const height = 20;
    const color = isUp ? '#ff3b30' : '#4cd964';

    const min = Math.min(...dataPoints);
    const max = Math.max(...dataPoints);
    const range = max - min || 1;

    const points = dataPoints.map((val, index) => {
      const x = (index / (dataPoints.length - 1)) * width;
      const y = height - ((val - min) / range) * height;
      return `${x},${y}`;
    }).join(' ');

    return `
        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="overflow:visible;">
            <polyline fill="none" stroke="${color}" stroke-width="2" points="${points}" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    `;
  }

  // 渲染市场列表 (带走势图版)
  function renderFundMarketList(funds) {
    const listEl = document.getElementById('fund-market-list');
    listEl.style.display = 'block';
    document.getElementById('fund-my-list').style.display = 'none';
    listEl.innerHTML = '';

    funds.forEach(fund => {
      const changeRate = ((fund.currentNav - fund.lastDayNav) / fund.lastDayNav) * 100;
      const isUp = changeRate >= 0;
      const colorClass = isUp ? 'fund-up' : 'fund-down';
      const sign = isUp ? '+' : '';

      let riskColorBg, riskColorText, riskText;
      if (fund.riskLevel === 'high') {
        riskColorBg = '#fff1f0'; riskColorText = '#ff4d4f'; riskText = '高风险';
      } else if (fund.riskLevel === 'medium') {
        riskColorBg = '#fff7e6'; riskColorText = '#fa8c16'; riskText = '中风险';
      } else {
        riskColorBg = '#f6ffed'; riskColorText = '#52c41a'; riskText = '稳健';
      }

      const riskTag = `<span class="fund-tag" style="background:${riskColorBg}; color:${riskColorText};">${riskText}</span>`;

      const chartData = [...(fund.history || []), fund.currentNav];
      const chartSvg = generateMiniChartSvg(chartData, isUp);

      const item = document.createElement('div');
      item.className = 'fund-item';
      item.onclick = () => openFundTradeModal('buy', fund);

      item.innerHTML = `
            <div class="fund-info" style="flex: 1.2;">
                <h4 style="margin-bottom:6px; font-size:15px;">${fund.name}</h4>
                <div class="fund-tags">
                    <span class="fund-tag" style="background:#f5f5f5; color:#999;">${fund.code}</span>
                    ${riskTag}
                </div>
            </div>
            
            <div class="fund-chart" style="flex: 1; display:flex; justify-content:center; align-items:center; opacity:0.8;">
                ${chartSvg}
            </div>

            <div class="fund-data" style="flex: 1; text-align:right;">
                <div class="fund-change ${colorClass}" style="font-size:18px; font-weight:bold;">${sign}${changeRate.toFixed(2)}%</div>
                <div class="fund-nav" style="font-size:11px; color:#999; margin-top:4px;">净值 ${fund.currentNav.toFixed(4)}</div>
            </div>
        `;
      listEl.appendChild(item);
    });
  }

  // 渲染持仓列表
  function renderFundMyList(funds, holdings) {
    const listEl = document.getElementById('fund-my-list');
    listEl.style.display = 'block';
    document.getElementById('fund-market-list').style.display = 'none';
    listEl.innerHTML = '';

    if (holdings.length === 0) {
      listEl.innerHTML = '<div style="text-align:center; padding:40px; color:#999;">暂无持仓</div>';
      return;
    }

    holdings.forEach(h => {
      const fund = funds.find(f => f.id === h.fundId);
      if (!fund) return;

      const marketValue = h.units * fund.currentNav;
      const costValue = h.units * h.cost;
      const profit = marketValue - costValue;
      const profitRate = (profit / costValue) * 100;

      const isUp = profit >= 0;
      const colorClass = isUp ? 'fund-up' : 'fund-down';
      const sign = isUp ? '+' : '';

      const item = document.createElement('div');
      item.className = 'fund-item';
      item.onclick = () => openFundTradeModal('sell', fund, h);
      item.innerHTML = `
            <div class="fund-info">
                <h4>${fund.name}</h4>
                <div style="font-size:12px; color:#666;">持有 ${h.units.toFixed(2)} 份</div>
            </div>
            <div class="fund-data">
                <div class="fund-change ${colorClass}">${sign}${profit.toFixed(2)}</div>
                <div class="fund-nav" style="font-size:11px;">${sign}${profitRate.toFixed(2)}%</div>
            </div>
        `;
      listEl.appendChild(item);
    });
  }

  // 切换 Tab
  function switchFundTab(tab) {
    activeFundTab = tab;
    document.querySelectorAll('.frame-tab').forEach(el => el.classList.remove('active'));
    document.getElementById(`tab-fund-${tab}`).classList.add('active');
    renderFundScreen();
  }

  // 交易相关
  let currentTradeContext = null;

  async function openFundTradeModal(type, fund, holding = null) {
    currentTradeContext = { type, fund, holding };
    const modal = document.getElementById('fund-trade-modal');

    const wallet = await db.userWallet.get('main');
    const balance = wallet.balance || 0;

    document.getElementById('fund-trade-name').textContent = fund.name;
    document.getElementById('fund-trade-code').textContent = fund.code;
    document.getElementById('fund-trade-nav').textContent = fund.currentNav.toFixed(4);

    const changeRate = ((fund.currentNav - fund.lastDayNav) / fund.lastDayNav) * 100;
    const changeEl = document.getElementById('fund-trade-change');
    changeEl.textContent = (changeRate >= 0 ? "+" : "") + changeRate.toFixed(2) + "%";
    changeEl.className = changeRate >= 0 ? 'fund-up' : 'fund-down';

    const inputEl = document.getElementById('fund-trade-amount');
    inputEl.value = '';
    const confirmBtn = document.getElementById('fund-confirm-btn');
    const titleEl = document.getElementById('fund-trade-title');
    const labelEl = document.getElementById('fund-trade-label');
    const infoEl = document.getElementById('fund-trade-info');

    if (type === 'buy') {
      titleEl.textContent = '买入基金';
      labelEl.innerHTML = `买入金额 (余额: ¥<span id="fund-wallet-balance">${balance.toFixed(2)}</span>)`;
      infoEl.textContent = "费率 0.00%";
      confirmBtn.textContent = "确认买入";
      confirmBtn.style.backgroundColor = "#1677ff";
      currentTradeContext.maxAmount = balance;
    } else {
      titleEl.textContent = '卖出基金';
      const holdingVal = holding.units * fund.currentNav;
      labelEl.innerHTML = `卖出金额 (持有: ¥<span id="fund-wallet-balance">${holdingVal.toFixed(2)}</span>)`;
      infoEl.textContent = `持有份额: ${holding.units.toFixed(2)} 份`;
      confirmBtn.textContent = "确认卖出";
      confirmBtn.style.backgroundColor = "#ff9800";
      currentTradeContext.maxAmount = holdingVal;
    }

    modal.classList.add('visible');
  }

  // 确认交易 (绑定在HTML onclick)
  window.handleFundTradeConfirm = async function () {
    if (!currentTradeContext) return;
    const amount = parseFloat(document.getElementById('fund-trade-amount').value);

    if (isNaN(amount) || amount <= 0) {
      document.getElementById('custom-modal-overlay').style.zIndex = 3002;
      await showCustomAlert("提示", "请输入有效金额");
      document.getElementById('custom-modal-overlay').style.zIndex = '';
      return;
    }
    if (amount > currentTradeContext.maxAmount) {
      document.getElementById('custom-modal-overlay').style.zIndex = 3002;
      await showCustomAlert("失败", "余额或份额不足");
      document.getElementById('custom-modal-overlay').style.zIndex = '';
      return;
    }

    const { type, fund } = currentTradeContext;
    const wallet = await db.userWallet.get('main');
    let holdings = wallet.fundHoldings || [];

    if (type === 'buy') {
      const success = await processTransaction(amount, 'expense', `基金买入-${fund.name}`);
      if (!success) return;

      const existing = holdings.find(h => h.fundId === fund.id);
      const newUnits = amount / fund.currentNav;

      if (existing) {
        const totalCost = (existing.units * existing.cost) + amount;
        existing.units += newUnits;
        existing.cost = totalCost / existing.units;
      } else {
        holdings.push({ fundId: fund.id, units: newUnits, cost: fund.currentNav });
      }
      await showCustomAlert("成功", "买入成功！");
    } else {
      const idx = holdings.findIndex(h => h.fundId === fund.id);
      if (idx === -1) return;

      const unitsToSell = amount / fund.currentNav;
      holdings[idx].units -= unitsToSell;
      if (holdings[idx].units < 0.01) holdings.splice(idx, 1);

      await processTransaction(amount, 'income', `基金卖出-${fund.name}`);
      await showCustomAlert("成功", "卖出成功！");
    }

    wallet.fundHoldings = holdings;
    await db.userWallet.put(wallet);

    checkThemeStatus();

    document.getElementById('fund-trade-modal').classList.remove('visible');
    renderFundScreen();
  };

async function openCharacterWalletScreen() {
  showScreen('character-wallet-screen');
  await renderCharacterWalletList();
}

async function renderCharacterWalletList() {
  const list = document.getElementById('character-wallet-list');
  if (!list) return;

  const characters = Object.values(state.chats || {}).filter(c => !c.isGroup);

  if (characters.length === 0) {
    list.innerHTML = '<p style="text-align:center; color:#999;">暂无角色</p>';
    return;
  }

  list.innerHTML = characters.map(chat => {
    const wallet = chat.simulatedTaobaoHistory || { totalBalance: 0, purchases: [] };
    const balance = Number(wallet.totalBalance || 0);

    return `
      <div class="wallet-role-card" style="background:white; border-radius:16px; padding:16px; margin-bottom:12px; box-shadow:0 2px 8px rgba(0,0,0,0.05);">
        <div style="display:flex; align-items:center; gap:12px;">
          <img src="${chat.settings?.aiAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'}" style="width:46px; height:46px; border-radius:50%; object-fit:cover;">
          <div style="flex:1;">
            <div style="font-weight:600; font-size:15px;">${chat.name}</div>
            <div style="font-size:13px; color:#888;">当前余额：¥${balance.toFixed(2)}</div>
          </div>
        </div>
        <div style="display:flex; gap:8px; margin-top:12px;">
          <button onclick="customRechargeCharacterWallet('${chat.id}')" style="flex:1; padding:8px; border-radius:10px; background:#1677ff; color:white;">充值</button>
          <button onclick="refreshCharacterWalletByAI('${chat.id}')" style="flex:1; padding:8px; border-radius:10px; background:#af52de; color:white;">AI刷新</button>
          <button onclick="openCharacterWalletLogs('${chat.id}')" style="flex:1; padding:8px; border-radius:10px; background:#34c759; color:white;">流水</button>
          <button onclick="resetCharacterWallet('${chat.id}')" style="flex:1; padding:8px; border-radius:10px; background:#999; color:white;">清零</button>
        </div>
      </div>
    `;
  }).join('');
}

async function rechargeCharacterWallet(chatId, amount) {
  const chat = state.chats[chatId];
  if (!chat) return;

  if (!chat.simulatedTaobaoHistory) {
    chat.simulatedTaobaoHistory = { totalBalance: 0, purchases: [] };
  }
  if (!chat.simulatedTaobaoHistory.purchases) {
    chat.simulatedTaobaoHistory.purchases = [];
  }
  if (!chat.simulatedTaobaoHistory.walletLogs) {
    chat.simulatedTaobaoHistory.walletLogs = [];
  }

  const oldBalance = Number(chat.simulatedTaobaoHistory.totalBalance || 0);
  const newBalance = oldBalance + Number(amount);

  chat.simulatedTaobaoHistory.totalBalance = newBalance;

  chat.simulatedTaobaoHistory.walletLogs.unshift({
    type: 'recharge',
    amount: Number(amount),
    balanceBefore: oldBalance,
    balanceAfter: newBalance,
    note: '手动充值',
    timestamp: Date.now()
  });

    await db.chats.put(chat);
    await renderCharacterWalletList();
    showToast(`已给 ${chat.name} 充值 ¥${Number(amount).toFixed(2)}`, 'success');
  }

async function customRechargeCharacterWallet(chatId) {
  const amountStr = await showCustomPrompt('角色钱包充值', '请输入充值金额：', '', 'number');
  if (!amountStr) return;

  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    alert('请输入有效金额');
    return;
  }

  await rechargeCharacterWallet(chatId, amount);
}

async function resetCharacterWallet(chatId) {
  const chat = state.chats[chatId];
  if (!chat) return;

  const confirmed = await showCustomConfirm(
    '确认清零',
    `确定要把 ${chat.name} 的角色钱包余额清零吗？`
  );

  if (!confirmed) return;

  if (!chat.simulatedTaobaoHistory) {
    chat.simulatedTaobaoHistory = { totalBalance: 0, purchases: [] };
  }

  if (!chat.simulatedTaobaoHistory.purchases) {
    chat.simulatedTaobaoHistory.purchases = [];
  }
  if (!chat.simulatedTaobaoHistory.walletLogs) {
    chat.simulatedTaobaoHistory.walletLogs = [];
  }

  const oldBalance = Number(chat.simulatedTaobaoHistory.totalBalance || 0);

  chat.simulatedTaobaoHistory.totalBalance = 0;

  chat.simulatedTaobaoHistory.walletLogs.unshift({
    type: 'reset',
    amount: -oldBalance,
    balanceBefore: oldBalance,
    balanceAfter: 0,
    note: '手动清零',
    timestamp: Date.now()
  });

  await db.chats.put(chat);
  await renderCharacterWalletList();

  showToast(`已清零 ${chat.name} 的角色钱包`, 'success');
}

async function openCharacterWalletLogs(chatId) {
  const chat = state.chats[chatId];
  if (!chat) return;

  const wallet = chat.simulatedTaobaoHistory || {};
  const logs = wallet.walletLogs || [];

  if (logs.length === 0) {
    await showCustomAlert('角色钱包流水', `${chat.name} 暂无钱包流水。`);
    return;
  }

  const recentLogs = logs.slice(0, 30);

  const html = `
  <div style="text-align:left;">
      ${recentLogs.map(log => {
        const amount = Number(log.amount || 0);
        const sign = amount >= 0 ? '+' : '';
        const color = amount >= 0 ? '#1677ff' : '#ff4d4f';
        const time = log.timestamp ? new Date(log.timestamp).toLocaleString('zh-CN') : '未知时间';
        const before = Number(log.balanceBefore || 0).toFixed(2);
        const after = Number(log.balanceAfter || 0).toFixed(2);

        return `
          <div style="padding:12px 0; border-bottom:1px solid #eee;">
            <div style="display:flex; justify-content:space-between; gap:10px;">
              <div style="font-weight:600;">${log.note || '钱包变动'}</div>
              <div style="font-weight:700; color:${color};">${sign}¥${amount.toFixed(2)}</div>
            </div>
            <div style="font-size:12px; color:#888; margin-top:4px;">${time}</div>
            <div style="font-size:12px; color:#999; margin-top:4px;">余额：¥${before} → ¥${after}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  await showCustomAlert(`${chat.name} 的钱包流水`, html);
}

function getWalletApiKey(apiKey) {
  if (!apiKey) return '';
  return String(apiKey)
    .split(/[,，\n]/)
    .map(s => s.trim())
    .filter(Boolean)[0] || '';
}

function extractWalletJson(text) {
  const raw = String(text || '').trim();
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw e;
  }
}

async function callWalletAI(chat, prompt) {
  const proxyUrl = chat.apiOverride?.proxyUrl || state.apiConfig.proxyUrl;
  const apiKey = getWalletApiKey(chat.apiOverride?.apiKey || state.apiConfig.apiKey);
  const model = chat.apiOverride?.model || state.apiConfig.model;

  if (!proxyUrl || !apiKey || !model) {
    throw new Error('API配置不完整，请先检查全局API或角色API设置。');
  }

  const isGemini = proxyUrl.includes('generativelanguage.googleapis.com');

  if (isGemini) {
    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: state.globalSettings.apiTemperature || 0.8
      }
    };

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err?.error?.message || 'Gemini API请求失败');
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '';
  }

  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: '你是角色钱包流水生成器。你必须只输出JSON，不要输出解释。'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: state.globalSettings.apiTemperature || 0.8
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err?.error?.message || 'API请求失败');
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

async function refreshCharacterWalletByAI(chatId) {
  const chat = state.chats[chatId];
  if (!chat) return;

  if (!chat.simulatedTaobaoHistory) {
    chat.simulatedTaobaoHistory = { totalBalance: 0, purchases: [], walletLogs: [] };
  }
  if (!chat.simulatedTaobaoHistory.walletLogs) {
    chat.simulatedTaobaoHistory.walletLogs = [];
  }

  const currentBalance = Number(chat.simulatedTaobaoHistory.totalBalance || 0);
  const recentLogs = chat.simulatedTaobaoHistory.walletLogs.slice(0, 10);
  const recentMessages = (chat.history || [])
    .filter(m => !m.isHidden)
    .slice(-20)
    .map(m => `${m.role}: ${String(m.content || m.dialogue || m.description || '').slice(0, 120)}`)
    .join('\n');

  const prompt = `
请根据角色设定、职业、最近剧情和当前余额，为角色钱包追加生成 1-5 条合理的收入/支出流水。

角色名：${chat.name}
角色设定：
${chat.settings?.aiPersona || '无'}

当前角色钱包余额：¥${currentBalance.toFixed(2)}

最近聊天：
${recentMessages || '无'}

最近钱包流水：
${recentLogs.map(log => `${log.note} ${log.amount}，余额 ${log.balanceBefore} -> ${log.balanceAfter}`).join('\n') || '无'}

要求：
1. 只输出 JSON。
2. 不要覆盖旧流水，只生成本次新增流水。
3. 可以有收入，也可以有支出。
4. 支出不要超过当前余额太多，尽量合理。
5. 金额必须是数字。
6. note 用中文，简短自然。
7. 不要生成购物车清空记录，购物车清空由购物系统负责。

输出格式：
{
  "logs": [
    {
      "type": "income",
      "amount": 12000,
      "note": "工资到账"
    },
    {
      "type": "expense",
      "amount": 68,
      "note": "买咖啡和晚餐"
    }
  ]
}
`;

  try {
    await showCustomAlert('AI刷新中', `正在根据 ${chat.name} 的剧情生成钱包流水...`);

    const aiText = await callWalletAI(chat, prompt);
    const parsed = extractWalletJson(aiText);
    const logs = Array.isArray(parsed.logs) ? parsed.logs : [];

    if (logs.length === 0) {
      await showCustomAlert('无新增流水', 'AI没有生成有效流水。');
      return;
    }

    let balance = currentBalance;
    let addedCount = 0;

    logs.forEach(log => {
      const rawAmount = Math.abs(Number(log.amount || 0));
      if (!rawAmount || isNaN(rawAmount)) return;

      const isExpense = log.type === 'expense';
      const amount = isExpense ? -rawAmount : rawAmount;

      const before = balance;
      let after = before + amount;

      if (after < 0) {
        after = 0;
      }

      chat.simulatedTaobaoHistory.walletLogs.unshift({
        type: isExpense ? 'expense' : 'income',
        amount: after - before,
        balanceBefore: before,
        balanceAfter: after,
        note: log.note || (isExpense ? '剧情支出' : '剧情收入'),
        timestamp: Date.now() + addedCount
      });

      balance = after;
      addedCount++;
    });

    chat.simulatedTaobaoHistory.totalBalance = balance;

    await db.chats.put(chat);
    await renderCharacterWalletList();

    await showCustomAlert('刷新完成', `已为 ${chat.name} 新增 ${addedCount} 条钱包流水。`);
  } catch (error) {
    console.error('[CharacterWallet] AI刷新钱包流水失败:', error);
    await showCustomAlert('刷新失败', error.message || 'AI刷新钱包流水失败。');
  }
}

async function getCharacterWalletPromptForChat(chatId) {
  try {
    const chat = state.chats[chatId];
    if (!chat) return '';

    const wallet = chat.simulatedTaobaoHistory || {};
    const balance = Number(wallet.totalBalance || 0);
    const logs = wallet.walletLogs || [];

    if (!logs.length && balance === 0) {
      return '';
    }

    const recentLogs = logs.slice(0, 8).map(log => {
      const amount = Number(log.amount || 0);
      const sign = amount >= 0 ? '+' : '';
      const time = log.timestamp
        ? new Date(log.timestamp).toLocaleString('zh-CN')
        : '未知时间';

      return `- ${time}：${log.note || '钱包变动'} ${sign}¥${amount.toFixed(2)}，余额 ¥${Number(log.balanceAfter || 0).toFixed(2)}`;
    }).join('\n');

    return `
# 角色钱包状态
你的当前钱包余额：¥${balance.toFixed(2)}

最近钱包流水：
${recentLogs || '暂无最近流水'}

这些是你的个人钱包记录。你可以在合适的时候自然参考这些收入、支出和余额，例如用户问你最近花了什么钱、有没有收入、钱包余额、是否能帮忙买东西时。
不要说“系统生成”“AI刷新”“钱包流水 prompt”等元信息。
不要主动长篇解释钱包，除非用户询问。
`;
  } catch (error) {
    console.warn('[CharacterWallet] 获取角色钱包提示失败:', error);
    return '';
  }
}

  // ========== 全局暴露 ==========
  window.openAlipayScreen = openAlipayScreen;
  window.renderTransactionList = renderTransactionList;
  window.initBillListUI = initBillListUI;
  window.handleUserTopUp = handleUserTopUp;
  window.openKinshipSelector = openKinshipSelector;
  window.sendKinshipRequest = sendKinshipRequest;
  window.BLACK_GOLD_THRESHOLD = BLACK_GOLD_THRESHOLD;
  window.checkThemeStatus = checkThemeStatus;
  window.openFundScreen = openFundScreen;
  window.openCharacterWalletScreen = openCharacterWalletScreen;
  window.rechargeCharacterWallet = rechargeCharacterWallet;
  window.customRechargeCharacterWallet = customRechargeCharacterWallet;
  window.refreshCharacterWalletByAI = refreshCharacterWalletByAI;
  window.getCharacterWalletPromptForChat = getCharacterWalletPromptForChat;
  window.resetCharacterWallet = resetCharacterWallet;
  window.openCharacterWalletLogs = openCharacterWalletLogs;
  window.switchFundTab = switchFundTab;
  window.refreshFundMarket = async () => {
    await showCustomAlert("刷新中", "正在更新行情...");
    await simulateFundMarket();
    await renderFundScreen();
  };
