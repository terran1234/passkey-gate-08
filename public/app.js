// 비공개 자리 화면: 서버 상태를 물어보고, 비공개 자료·패스키 목록·등록 폼을 그린다.
// 비공개 내용은 이 파일에 없다. 로그인해서 서버가 내려 줄 때만 화면에 들어온다.
(function () {
  var $ = function (id) { return document.getElementById(id); };

  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) { return { status: r.status, data: data }; });
    });
  }

  function show(id, on) { $(id).hidden = !on; }

  function renderVault(items) {
    var ul = $('vault-items'); ul.innerHTML = '';
    items.forEach(function (it) {
      var li = document.createElement('li');
      var k = document.createElement('div'); k.className = 'kind'; k.textContent = it.kind;
      var h = document.createElement('h3'); h.textContent = it.title;
      var p = document.createElement('p'); p.textContent = it.body;
      li.appendChild(k); li.appendChild(h); li.appendChild(p); ul.appendChild(li);
    });
  }

  function row(dl, label, value, plain) {
    var dt = document.createElement('dt'); dt.textContent = label;
    var dd = document.createElement('dd'); dd.textContent = value; if (plain) dd.className = 'plain';
    dl.appendChild(dt); dl.appendChild(dd);
  }

  function renderPasskeys(list) {
    var ul = $('passkey-list'); ul.innerHTML = '';
    $('list-hint').textContent = list.length >= 2
      ? '패스키가 ' + list.length + '개 등록되어 있습니다. 하나를 잃어버려도 다른 하나로 들어올 수 있습니다.'
      : '패스키가 1개뿐입니다. 이 기기를 잃어버리면 들어올 수 없으니 다른 기기에서 하나 더 추가해 두세요. 마지막 하나는 지울 수 없습니다.';
    list.forEach(function (c) {
      var li = document.createElement('li');
      var head = document.createElement('div'); head.className = 'pk-head';
      var n = document.createElement('div'); n.className = 'pk-name'; n.textContent = c.name; head.appendChild(n);
      var del = document.createElement('button'); del.type = 'button'; del.className = 'del'; del.textContent = '지우기';
      del.disabled = list.length <= 1;
      if (del.disabled) del.title = '마지막 패스키는 지울 수 없습니다';
      del.addEventListener('click', function () { removePasskey(c); });
      head.appendChild(del); li.appendChild(head);
      var dl = document.createElement('dl');
      row(dl, '만든 곳', c.authenticator + (c.deviceType === 'multiDevice' ? ' · 여러 기기에 동기화되는 패스키' + (c.backedUp ? '(백업됨)' : '') : ' · 이 기기에만 있는 패스키'), true);
      row(dl, '전달 방식', (c.transports && c.transports.length ? c.transports.join(', ') : '알 수 없음'), true);
      row(dl, '등록 시각', new Date(c.createdAt).toLocaleString('ko-KR'), true);
      row(dl, '패스키 ID', c.id);
      row(dl, '서버에 저장된 공개키', c.publicKey);
      li.appendChild(dl); ul.appendChild(li);
    });
  }

  function removePasskey(c) {
    var msg = $('msg-list'); msg.className = 'form-msg'; msg.textContent = '';
    if (!window.confirm('"' + c.name + '" 패스키를 지울까요?\n이 패스키가 들어 있는 기기로는 더 이상 들어올 수 없습니다.')) return;
    api('/api/passkeys/' + encodeURIComponent(c.id), { method: 'DELETE' }).then(function (r) {
      if (r.status === 200) { msg.className = 'form-msg ok'; msg.textContent = '"' + r.data.name + '" 패스키를 지웠습니다. 남은 패스키: ' + r.data.remaining + '개'; return refresh(); }
      msg.textContent = (r.data.message || '지우지 못했습니다') + ' (' + r.status + ')';
    });
  }

  // 화면 상태: 서버가 알려 주는 (등록 여부, 로그인 여부)에 따라 보여 줄 칸이 달라진다.
  function refresh() {
    return api('/api/status').then(function (s) {
      var st = s.data;
      show('register-first', !st.registered);
      show('need-login', st.registered && !st.loggedIn);
      show('vault-locked', !st.loggedIn);
      show('vault-items', st.loggedIn);
      show('passkey-manage', st.loggedIn);
      if (!st.loggedIn) {
        $('invite-code').hidden = true; $('invite-code').textContent = '';
        $('vault-status').textContent = '로그인하지 않았습니다. 비공개 자료를 서버에 요청해 보면 거절됩니다.';
        // 로그인하지 않은 채 요청해 보면 서버가 401로 거절한다는 것을 화면에도 보여 준다.
        return api('/api/vault').then(function (v) { $('vault-status').textContent = '로그인하지 않았습니다 (서버 응답 ' + v.status + ')'; });
      }
      return Promise.all([api('/api/vault'), api('/api/passkeys')]).then(function (r) {
        renderVault(r[0].data.items || []);
        renderPasskeys(r[1].data.passkeys || []);
      });
    }).catch(function () { $('vault-status').textContent = '서버에 연결하지 못했습니다'; });
  }

  // 등록: 질문 받기 → 기기가 열쇠 만들기 → 공개키·서명 보내기
  function register(body, msgEl, button) {
    msgEl.className = 'form-msg'; msgEl.textContent = '';
    if (!window.SimpleWebAuthnBrowser || !window.PublicKeyCredential) {
      msgEl.textContent = '이 브라우저는 패스키를 지원하지 않습니다.'; return Promise.resolve();
    }
    button.disabled = true;
    return api('/api/register/options', { method: 'POST', body: body }).then(function (o) {
      if (o.status !== 200) { msgEl.textContent = o.data.message || ('등록을 시작하지 못했습니다 (' + o.status + ')'); return; }
      return window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: o.data }).then(function (att) {
        return api('/api/register/verify', { method: 'POST', body: att }).then(function (v) {
          if (v.status === 200 && v.data.verified) {
            msgEl.className = 'form-msg ok'; msgEl.textContent = '패스키 "' + v.data.credential.name + '"를 등록했습니다.';
            return refresh();
          }
          msgEl.textContent = v.data.message || ('등록하지 못했습니다 (' + v.status + ')');
        });
      }, function (err) {
        // 사용자가 패스키 창을 닫거나 취소하면 여기로 온다. 서버에는 보낸 것이 없으므로 저장된 것도 없다.
        api('/api/register/cancel', { method: 'POST', body: {} });
        if (err && err.name === 'InvalidStateError') msgEl.textContent = '이 기기에는 이미 이 사이트의 패스키가 등록되어 있습니다.';
        else if (err && err.name === 'NotAllowedError') msgEl.textContent = '등록을 취소했습니다. 아무것도 저장되지 않았습니다.';
        else msgEl.textContent = '등록하지 못했습니다: ' + (err && err.name ? err.name : '알 수 없는 오류') + '. 아무것도 저장되지 않았습니다.';
      });
    }).then(function () { button.disabled = false; }, function () { button.disabled = false; });
  }

  $('form-first').addEventListener('submit', function (e) {
    e.preventDefault();
    register({ name: $('in-name-first').value, setupCode: $('in-setup').value }, $('msg-first'), e.target.querySelector('button'))
      .then(function () { $('in-setup').value = ''; });
  });
  $('form-add').addEventListener('submit', function (e) {
    e.preventDefault();
    register({ name: $('in-name-add').value }, $('msg-add'), e.target.querySelector('button'))
      .then(function () { $('in-name-add').value = ''; });
  });
  // 새 기기 추가: 로그인한 기기에서 일회용 코드를 만들고, 패스키가 없는 새 기기에서 그 코드로 패스키를 만든다.
  var inviteTimer = null;
  $('btn-invite').addEventListener('click', function () {
    var box = $('invite-code');
    api('/api/passkeys/invite', { method: 'POST', body: {} }).then(function (r) {
      if (r.status !== 200) { box.hidden = false; box.textContent = '코드를 만들지 못했습니다 (' + r.status + ')'; return; }
      box.hidden = false; box.textContent = r.data.code;
      clearTimeout(inviteTimer);
      inviteTimer = setTimeout(function () { box.hidden = true; box.textContent = ''; }, r.data.expiresInSeconds * 1000);
    });
  });
  $('form-addcode').addEventListener('submit', function (e) {
    e.preventDefault();
    register({ name: $('in-name-addcode').value, addCode: $('in-addcode').value }, $('msg-addcode'), e.target.querySelector('button'))
      .then(function () { $('in-addcode').value = ''; });
  });

  // 로그인: 질문 받기 → 기기가 개인키로 서명 → 서명 보내기. 서버가 공개키로 확인해야 세션이 생긴다.
  $('btn-login').addEventListener('click', function (e) {
    var btn = e.target, msg = $('msg-login');
    msg.className = 'form-msg'; msg.textContent = '';
    if (!window.SimpleWebAuthnBrowser || !window.PublicKeyCredential) { msg.textContent = '이 브라우저는 패스키를 지원하지 않습니다.'; return; }
    btn.disabled = true;
    api('/api/login/options', { method: 'POST', body: {} }).then(function (o) {
      if (o.status !== 200) { msg.textContent = o.data.message || ('로그인을 시작하지 못했습니다 (' + o.status + ')'); return; }
      return window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: o.data }).then(function (assertion) {
        return api('/api/login/verify', { method: 'POST', body: assertion }).then(function (v) {
          if (v.status === 200 && v.data.verified) return refresh();
          msg.textContent = (v.data.message || '로그인하지 못했습니다') + ' (' + v.status + ')';
        });
      }, function (err) {
        if (err && err.name === 'NotAllowedError') msg.textContent = '로그인을 취소했습니다. 비공개 자리는 열리지 않았습니다.';
        else msg.textContent = '로그인하지 못했습니다: ' + (err && err.name ? err.name : '알 수 없는 오류');
      });
    }).then(function () { btn.disabled = false; }, function () { btn.disabled = false; });
  });

  $('btn-logout').addEventListener('click', function () {
    api('/api/logout', { method: 'POST', body: {} }).then(refresh);
  });

  refresh();
})();
