// ==UserScript==
// @name         3CX Trunk Number Copier + Route Cloner (Final v4.0)
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Safely copy DIDs and OfficeHours routes from one trunk to another in 3CX without overwriting anything
// @match        *://*.3cx.be/*
// @match        *://*.3cx.com/*
// @match        *://*.3cx.eu/*
// @match        *://*.my3cx.be/*
// @match        *://*.my3cx.eu/*
// @grant        GM_notification
// @grant        GM_addStyle
// ==/UserScript==

(function () {
    'use strict';

    // === Capture Bearer Token ===
    (function () {
        const orig = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function (h, v) {
            if (h.toLowerCase() === 'authorization' && v.startsWith('Bearer ')) {
                window.__activeBearerToken = v.substring(7);
            }
            return orig.apply(this, arguments);
        };
    })();

    function getActiveBearerToken() {
        return window.__activeBearerToken || null;
    }

    const observer = new MutationObserver(() => {
        if (window.location.hash.startsWith('#/office/voice-and-chat/trunk/edit/')) {
            injectCopyButton();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    function injectCopyButton() {
        if (document.getElementById('copy-did-btn')) return;
        const saveBtn = document.querySelector('button#btnSave');
        const container = saveBtn?.closest('.d-flex.gap-1');
        if (!container) return;

        const btn = document.createElement('button');
        btn.id = 'copy-did-btn';
        btn.className = 'btn btn-secondary';
        btn.textContent = 'Copy Numbers to Trunk';
        btn.onclick = () => showTrunkDropdown(btn);

        container.appendChild(btn);
    }

    async function showTrunkDropdown(button) {
        const dropdownId = 'did-copy-dropdown';
        let dropdown = document.getElementById(dropdownId) || document.createElement('div');
        dropdown.id = dropdownId;
        dropdown.className = 'holidays-dropdown-menu';
        document.body.appendChild(dropdown);

        const rect = button.getBoundingClientRect();
        dropdown.style.top = `${rect.bottom + window.scrollY}px`;
        dropdown.style.left = `${rect.left + window.scrollX}px`;
        dropdown.style.display = 'block';
        dropdown.innerHTML = '<p>Loading trunks...</p>';

        try {
            const sourceTrunkId = window.location.hash.split('/').pop();
            const token = await getBearerToken();
            const trunks = await fetchTrunks(token);

            dropdown.innerHTML = '<h4>Select destination trunk:</h4>';
            const form = document.createElement('form');
            form.className = 'department-list';

            trunks.forEach(t => {
                if (t.Id.toString() !== sourceTrunkId) {
                    const div = document.createElement('div');
                    const radio = document.createElement('input');
                    radio.type = 'radio';
                    radio.name = 'trunk';
                    radio.value = t.Id;
                    radio.id = `trunk-${t.Id}`;

                    const label = document.createElement('label');
                    label.htmlFor = radio.id;
                    label.textContent = t.Gateway?.Name || `Trunk ${t.Id}`;
                    div.appendChild(radio);
                    div.appendChild(label);
                    form.appendChild(div);
                }
            });

            const confirm = document.createElement('button');
            confirm.type = 'button';
            confirm.textContent = 'Copy DID Numbers + Routes';
            confirm.onclick = async () => {
                const selected = form.querySelector('input[name="trunk"]:checked');
                if (!selected) return alert('Please select a destination trunk');
                dropdown.innerHTML = '<p>Copying numbers & routes...</p>';

                try {
                    await copyDIDsAndRoutes(sourceTrunkId, selected.value, token);
                    GM_notification({ title: '3CX', text: 'DIDs & routes copied (preserved)', timeout: 5000 });
                    dropdown.style.display = 'none';
                } catch (err) {
                    alert('Error copying routes');
                    console.error(err);
                    dropdown.style.display = 'none';
                }
            };

            form.appendChild(confirm);
            dropdown.appendChild(form);
        } catch (e) {
            dropdown.innerHTML = `<p>Error: ${e.message}</p>`;
        }
    }

    async function getBearerToken() {
        const token = getActiveBearerToken();
        if (token) return token;

        const username = prompt("3CX Admin Username:");
        const password = prompt("3CX Admin Password:");
        const res = await fetch(`${location.origin}/webclient/api/Login/GetAccessToken`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ Username: username, Password: password, SecurityCode: '' })
        });

        const data = await res.json();
        if (data?.Status !== 'AuthSuccess') throw new Error(data?.Message || 'Login failed');
        window.__activeBearerToken = data.Token.access_token;
        return data.Token.access_token;
    }

    async function fetchTrunks(token) {
        const res = await fetch(`${location.origin}/xapi/v1/Trunks?$select=Id,Gateway`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        return data.value || [];
    }

    async function copyDIDsAndRoutes(sourceId, targetId, token) {
        // Step 1: Fetch DIDs from both source and destination
        const [sourceDIDs, destinationDIDs] = await Promise.all([
            fetch(`${location.origin}/xapi/v1/Trunks(${sourceId})?$select=DidNumbers`, {
                headers: { 'Authorization': `Bearer ${token}` }
            }).then(r => r.json()).then(d => d.DidNumbers || []),

            fetch(`${location.origin}/xapi/v1/Trunks(${targetId})?$select=DidNumbers`, {
                headers: { 'Authorization': `Bearer ${token}` }
            }).then(r => r.json()).then(d => d.DidNumbers || [])
        ]);

        const combinedDIDs = Array.from(new Set([...destinationDIDs, ...sourceDIDs]));

        const patchRes = await fetch(`${location.origin}/xapi/v1/Trunks(${targetId})`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ DidNumbers: combinedDIDs })
        });
        if (patchRes.status !== 204) {
            throw new Error(`Failed to patch destination trunk. Status: ${patchRes.status}`);
        }

        // Step 2: Get DID routing mappings from source trunk
        const routingRes = await fetch(`${location.origin}/xapi/v1/DidNumbers?$select=Number,TrunkId&$expand=RoutingRule&$filter=TrunkId eq ${sourceId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const routingData = await routingRes.json();
        const routes = routingData.value || [];

        const targetMappings = routes
            .map(r => ({
                did: r.Number,
                ext: r.RoutingRule?.OfficeHoursDestination?.Number
            }))
            .filter(r => r.did && r.ext);

        if (!targetMappings.length) return;

        const uniqueExts = [...new Set(targetMappings.map(r => `'${r.ext}'`))];
        const peerQuery = uniqueExts.join(' or Number eq ');

        const peersRes = await fetch(`${location.origin}/xapi/v1/Peers?$filter=Number eq ${peerQuery}&$select=Type,Id,Number`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const peersData = await peersRes.json();
        const peerMap = {};
        (peersData.value || []).forEach(p => { peerMap[p.Number] = p.Id; });

        const peerIds = Object.values(peerMap);
        if (!peerIds.length) return;

        const routeDefsRes = await fetch(`${location.origin}/xapi/v1/Defs/Pbx.GetRoutes`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ids: peerIds })
        });
        const defsData = await routeDefsRes.json();
        const currentRoutesMap = {};
        (defsData.value || []).forEach(entry => {
            currentRoutesMap[entry.Id] = entry.Routes || [];
        });

        for (const mapping of targetMappings) {
            const peerId = peerMap[mapping.ext];
            if (!peerId) continue;

            const existing = currentRoutesMap[peerId] || [];
            const exists = existing.some(r =>
                r.DID === mapping.did && r.TrunkId === parseInt(targetId)
            );
            if (!exists) {
                existing.push({
                    DID: mapping.did,
                    TrunkId: parseInt(targetId),
                    DisplayName: ""
                });
            }

            const payload = {
                routes: {
                    Id: peerId,
                    Routes: existing
                }
            };

            const routeRes = await fetch(`${location.origin}/xapi/v1/Trunks/Pbx.SetRoutes`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!routeRes.ok) {
                console.error(`Failed to set routes for Peer ${peerId}`, await routeRes.text());
            }
        }
    }

    document.addEventListener('click', e => {
        const dropdown = document.getElementById('did-copy-dropdown');
        const btn = document.getElementById('copy-did-btn');
        if (dropdown && !dropdown.contains(e.target) && e.target !== btn) {
            dropdown.style.display = 'none';
        }
    });

    GM_addStyle(`
        .holidays-dropdown-menu {
            position: absolute;
            background: white;
            border: 1px solid #ccc;
            border-radius: 4px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2);
            z-index: 2147483647;
            min-width: 250px;
            padding: 12px;
        }
        .department-list {
            max-height: 300px;
            overflow-y: auto;
            margin-bottom: 10px;
        }
        .department-list div {
            margin-bottom: 5px;
        }
        .holidays-dropdown-menu button {
            margin-top: 10px;
            padding: 6px 12px;
            background: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }
        .holidays-dropdown-menu button:hover {
            background: #0056b3;
        }
    `);
})();
