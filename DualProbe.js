/**
 * Multi Server Monitor for Egern.
 *
 * Designed as a multi-server version of xcgtb/Egern-Widgets Probe.js.
 * It keeps the same compact white/dark telemetry style, but renders every
 * configured SSH probe in one widget instead of rotating between servers.
 */
export default async function (ctx) {
  const env = ctx.env || {};

  const C = {
    bg: { light: '#FFFFFF', dark: '#121212' },
    barBg: { light: '#0000001A', dark: '#FFFFFF22' },
    panelBg: { light: '#F7F7FA', dark: '#1C1C1E' },
    text: { light: '#1C1C1E', dark: '#FFFFFF' },
    dim: { light: '#8E8E93', dark: '#8E8E93' },
    cpu: { light: '#007AFF', dark: '#0A84FF' },
    mem: { light: '#AF52DE', dark: '#BF5AF2' },
    disk: { light: '#FF9500', dark: '#FF9F0A' },
    netRx: { light: '#34C759', dark: '#30D158' },
    netTx: { light: '#5856D6', dark: '#5E5CE6' },
    red: { light: '#FF3B30', dark: '#FF453A' },
  };

  const read = (...keys) => {
    for (const key of keys) {
      const value = env[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
    return '';
  };

  const maxServers = 8;
  const requestedCount = Math.max(1, Math.min(maxServers, Number(read('SERVER_COUNT', 'NODE_COUNT', 'SSH_SERVER_COUNT')) || 2));

  const getServer = (i) => ({
    id: String(i),
    widgetName: read(`SERVER_${i}_NAME`, `NODE${i}_NAME`, `SSH_SERVER_${i}_NAME`) || `Node ${i}`,
    host: read(`SERVER_${i}_HOST`, `NODE${i}_HOST`, `SSH_SERVER_${i}_HOST`),
    port: Number(read(`SERVER_${i}_PORT`, `NODE${i}_PORT`, `SSH_SERVER_${i}_PORT`)) || 22,
    username: read(`SERVER_${i}_USER`, `NODE${i}_USER`, `SSH_SERVER_${i}_USER`) || 'root',
    password: read(`SERVER_${i}_PASSWORD`, `NODE${i}_PASSWORD`, `SSH_SERVER_${i}_PWD`),
    privateKey: read(`SERVER_${i}_KEY`, `NODE${i}_KEY`, `SSH_SERVER_${i}_KEY`),
  });

  const servers = Array.from({ length: requestedCount }, (_, i) => getServer(i + 1)).filter(s => s.host);

  const fmtBytes = (b) => {
    if (!Number.isFinite(b)) return '0B';
    if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(2) + 'T';
    if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + 'G';
    if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + 'M';
    if (b >= 1024) return (b / 1024).toFixed(0) + 'K';
    return Math.round(b) + 'B';
  };

  const normalizePrivateKey = (privateKey) => {
    if (!privateKey || typeof privateKey !== 'string') return '';
    const raw = privateKey.trim().replace(/\\n/g, '\n').replace(/\\r/g, '');
    const headerMatch = raw.match(/-----BEGIN [A-Z0-9 ]+-----/);
    const footerMatch = raw.match(/-----END [A-Z0-9 ]+-----/);
    if (!headerMatch || !footerMatch) return raw;

    const header = headerMatch[0];
    const footer = footerMatch[0];
    const body = raw
      .substring(raw.indexOf(header) + header.length, raw.indexOf(footer))
      .replace(/\s+/g, '');
    const lines = body.match(/.{1,64}/g) || [];
    return `${header}\n${lines.join('\n')}\n${footer}`;
  };

  const runProbe = async (server) => {
    let session;
    try {
      const finalKey = normalizePrivateKey(server.privateKey);
      session = await ctx.ssh.connect({
        host: server.host,
        port: server.port,
        username: server.username,
        ...(finalKey ? { privateKey: finalKey } : { password: server.password }),
        timeout: 8000,
      });

      const SEP = '<<EG-DUAL-SEP>>';
      const cmds = [
        'hostname -s 2>/dev/null || hostname',
        'cat /proc/loadavg',
        'cat /proc/uptime',
        'head -1 /proc/stat',
        "awk '/MemTotal/{t=$2}/MemFree/{f=$2}/Buffers/{b=$2}/^Cached/{c=$2}END{print t,f,b,c}' /proc/meminfo",
        'df -B1 / | tail -1',
        'nproc',
        "curl -s -m 2 http://ip-api.com/line?fields=country,city,query || echo ''",
        "awk '/^ *(eth|en|wlan|ens|eno|bond|veth)/{rx+=$2;tx+=$10}END{print rx,tx}' /proc/net/dev",
      ];
      const { stdout } = await session.exec(cmds.join(` && echo '${SEP}' && `));
      await session.close();
      session = null;

      const p = stdout.split(SEP).map(s => s.trim());
      const hostname = server.widgetName || p[0] || `Node ${server.id}`;
      const load = (p[1] || '0 0 0').split(' ').slice(0, 3);

      const upSec = parseFloat((p[2] || '0').split(' ')[0]);
      const upDays = Math.floor(upSec / 86400);
      const upHours = Math.floor((upSec % 86400) / 3600);
      const uptime = upDays > 0 ? `${upDays}天 ${upHours}小时` : `${upHours}小时`;

      const cpuNums = (p[3] || '').replace(/^cpu\s+/, '').split(/\s+/).map(Number);
      const cpuTotal = cpuNums.reduce((a, b) => a + b, 0);
      const cpuIdle = cpuNums[3] || 0;
      const cpuKey = `_dual_cpu_${server.id}`;
      const prevCpu = ctx.storage.getJSON(cpuKey);
      let cpuPct = 0;
      if (prevCpu && cpuTotal > prevCpu.t) {
        cpuPct = Math.round(((cpuTotal - prevCpu.t - (cpuIdle - prevCpu.i)) / (cpuTotal - prevCpu.t)) * 100);
      }
      ctx.storage.setJSON(cpuKey, { t: cpuTotal, i: cpuIdle });
      cpuPct = Math.max(0, Math.min(100, cpuPct));

      const memKB = (p[4] || '0 0 0 0').split(' ').map(Number);
      const memTotal = memKB[0] * 1024 || 1;
      const memUsed = memTotal - (memKB[1] * 1024 || 0) - (memKB[2] * 1024 || 0) - (memKB[3] * 1024 || 0);
      const memPct = Math.min(100, Math.round((memUsed / memTotal) * 100));

      const df = (p[5] || '').split(/\s+/);
      const diskTotal = Number(df[1]) || 1;
      const diskUsed = Number(df[2]) || 0;
      const diskPct = parseInt(df[4], 10) || 0;
      const cores = parseInt(p[6], 10) || 1;

      let ipInfo = server.host;
      let locInfo = '未知';
      const ipApiLines = (p[7] || '').split('\n').map(s => s.trim()).filter(Boolean);
      if (ipApiLines.length >= 3) {
        locInfo = `${ipApiLines[0]} ${ipApiLines[1]}`.replace(/United States/g, 'US').replace(/United Kingdom/g, 'UK');
        ipInfo = ipApiLines[2];
      }

      const nn = (p[8] || '0 0').split(' ');
      const netRx = Number(nn[0]) || 0;
      const netTx = Number(nn[1]) || 0;
      const netKey = `_dual_net_${server.id}`;
      const prevNet = ctx.storage.getJSON(netKey);
      const now = Date.now();
      let rxRate = 0;
      let txRate = 0;
      if (prevNet && prevNet.ts) {
        const elapsed = (now - prevNet.ts) / 1000;
        if (elapsed > 0 && elapsed < 3600) {
          rxRate = Math.max(0, (netRx - prevNet.rx) / elapsed);
          txRate = Math.max(0, (netTx - prevNet.tx) / elapsed);
        }
      }
      ctx.storage.setJSON(netKey, { rx: netRx, tx: netTx, ts: now });

      return {
        ok: true,
        id: server.id,
        hostname,
        uptime,
        load,
        cores,
        cpuPct,
        memTotal,
        memUsed,
        memPct,
        diskTotal,
        diskUsed,
        diskPct,
        rxRate,
        txRate,
        ipInfo,
        locInfo,
      };
    } catch (e) {
      if (session) {
        try { await session.close(); } catch (_) {}
      }
      return {
        ok: false,
        id: server.id,
        hostname: server.widgetName || `Node ${server.id}`,
        error: String(e && e.message ? e.message : e),
      };
    }
  };

  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const bar = (pct, color, h = 5, segCount = 18) => {
    const activeCount = Math.round((Math.max(0, Math.min(100, pct)) / 100) * segCount);
    return {
      type: 'stack',
      direction: 'row',
      height: h,
      gap: 1.5,
      children: Array.from({ length: segCount }).map((_, i) => ({
        type: 'stack',
        flex: 1,
        height: h,
        borderRadius: 1,
        backgroundColor: i < activeCount ? color : C.barBg,
        opacity: i < activeCount ? 0.45 + 0.55 * (i / Math.max(activeCount - 1, 1)) : 1,
      })),
    };
  };

  const metricRow = (icon, label, pct, value, color) => ({
    type: 'stack',
    direction: 'column',
    gap: 3,
    children: [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 4,
        children: [
          { type: 'image', src: `sf-symbol:${icon}`, color, width: 10, height: 10 },
          { type: 'text', text: label, font: { size: 10, weight: 'bold' }, textColor: C.text },
          { type: 'spacer' },
          { type: 'text', text: value, font: { size: 10, weight: 'heavy', family: 'Menlo' }, textColor: color, maxLines: 1, minScale: 0.75 },
        ],
      },
      bar(pct, color, 5),
    ],
  });

  const statPill = (label, value, color) => ({
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 2,
    children: [
      { type: 'text', text: label, font: { size: 8, weight: 'bold' }, textColor: C.dim, maxLines: 1 },
      { type: 'text', text: value, font: { size: 9, weight: 'heavy', family: 'Menlo' }, textColor: color, maxLines: 1 },
    ],
  });

  const denseServerLine = (d) => {
    const okColor = d.ok ? C.netRx : C.red;
    return {
      type: 'stack',
      direction: 'column',
      gap: 3,
      padding: [5, 0],
      children: [
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 4,
          children: [
            { type: 'image', src: d.ok ? 'sf-symbol:server.rack' : 'sf-symbol:xmark.octagon.fill', color: okColor, width: 10, height: 10 },
            { type: 'text', text: d.hostname, font: { size: 10, weight: 'bold' }, textColor: C.text, maxLines: 1, minScale: 0.65 },
            { type: 'spacer' },
            { type: 'text', text: d.ok ? `↓${fmtBytes(d.rxRate)}/s ↑${fmtBytes(d.txRate)}/s` : 'ERR', font: { size: 8, weight: 'bold', family: 'Menlo' }, textColor: d.ok ? C.dim : C.red, maxLines: 1, minScale: 0.65 },
          ],
        },
        d.ok ? {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 6,
          children: [
            statPill('C', `${d.cpuPct}%`, C.cpu),
            statPill('M', `${d.memPct}%`, C.mem),
            statPill('D', `${d.diskPct}%`, C.disk),
            { type: 'spacer' },
            { type: 'text', text: d.ipInfo, font: { size: 8, family: 'Menlo' }, textColor: C.dim, maxLines: 1, minScale: 0.6 },
          ],
        } : { type: 'text', text: d.error, font: { size: 8 }, textColor: C.dim, maxLines: 1, minScale: 0.6 },
      ],
    };
  };

  const compactServerLine = (d) => {
    if (!d.ok) {
      return {
        type: 'stack',
        direction: 'column',
        gap: 4,
        padding: [7, 8],
        borderRadius: 8,
        backgroundColor: C.panelBg,
        children: [
          {
            type: 'stack',
            direction: 'row',
            alignItems: 'center',
            gap: 5,
            children: [
              { type: 'image', src: 'sf-symbol:xmark.octagon.fill', color: C.red, width: 11, height: 11 },
              { type: 'text', text: d.hostname, font: { size: 11, weight: 'bold' }, textColor: C.text, maxLines: 1 },
              { type: 'spacer' },
              { type: 'text', text: 'offline', font: { size: 9, weight: 'bold', family: 'Menlo' }, textColor: C.red },
            ],
          },
          { type: 'text', text: d.error, font: { size: 9 }, textColor: C.dim, maxLines: 1, minScale: 0.65 },
        ],
      };
    }

    return {
      type: 'stack',
      direction: 'column',
      gap: 5,
      padding: [7, 8],
      borderRadius: 8,
      backgroundColor: C.panelBg,
      children: [
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 5,
          children: [
            { type: 'image', src: 'sf-symbol:server.rack', color: C.text, width: 11, height: 11 },
            { type: 'text', text: d.hostname, font: { size: 11, weight: 'bold' }, textColor: C.text, maxLines: 1, minScale: 0.65 },
            { type: 'spacer' },
            { type: 'text', text: `↓${fmtBytes(d.rxRate)}/s ↑${fmtBytes(d.txRate)}/s`, font: { size: 8, family: 'Menlo', weight: 'bold' }, textColor: C.dim, maxLines: 1, minScale: 0.65 },
          ],
        },
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 8,
          children: [
            statPill('CPU', `${d.cpuPct}%`, C.cpu),
            statPill('MEM', `${d.memPct}%`, C.mem),
            statPill('DSK', `${d.diskPct}%`, C.disk),
            { type: 'spacer' },
            { type: 'text', text: `${d.uptime} · ${d.load[0]}`, font: { size: 8, family: 'Menlo' }, textColor: C.dim, maxLines: 1, minScale: 0.7 },
          ],
        },
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 4,
          children: [
            { type: 'image', src: 'sf-symbol:network', color: C.dim, width: 9, height: 9 },
            { type: 'text', text: d.ipInfo, font: { size: 8, family: 'Menlo', weight: 'bold' }, textColor: C.text, maxLines: 1, minScale: 0.65 },
            { type: 'text', text: '-', font: { size: 8 }, textColor: C.dim },
            { type: 'text', text: d.locInfo, font: { size: 8, weight: 'medium' }, textColor: C.dim, maxLines: 1, minScale: 0.65 },
          ],
        },
      ],
    };
  };

  const serverBlock = (d, compact = false) => {
    if (!d.ok) {
      return {
        type: 'stack',
        direction: 'column',
        gap: 5,
        padding: compact ? 0 : [10, 10],
        borderRadius: compact ? 0 : 8,
        backgroundColor: compact ? '#00000000' : C.panelBg,
        children: [
          {
            type: 'stack',
            direction: 'row',
            alignItems: 'center',
            gap: 5,
            children: [
              { type: 'image', src: 'sf-symbol:xmark.octagon.fill', color: C.red, width: 12, height: 12 },
              { type: 'text', text: d.hostname, font: { size: compact ? 11 : 12, weight: 'bold' }, textColor: C.text, maxLines: 1 },
            ],
          },
          { type: 'text', text: d.error, font: { size: 9 }, textColor: C.dim, maxLines: compact ? 1 : 2, minScale: 0.75 },
        ],
      };
    }

    const rows = [
      metricRow('cpu', `CPU ${d.cores}C`, d.cpuPct, `${d.cpuPct}%`, C.cpu),
      metricRow('memorychip', 'MEM', d.memPct, `${d.memPct}%`, C.mem),
      metricRow('internaldrive', 'DSK', d.diskPct, `${d.diskPct}%`, C.disk),
    ];

    return {
      type: 'stack',
      direction: 'column',
      gap: compact ? 5 : 7,
      padding: compact ? 0 : [10, 10],
      borderRadius: compact ? 0 : 8,
      backgroundColor: compact ? '#00000000' : C.panelBg,
      children: [
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 5,
          children: [
            { type: 'image', src: 'sf-symbol:server.rack', color: C.text, width: 12, height: 12 },
            { type: 'text', text: d.hostname, font: { size: compact ? 11 : 12, weight: 'bold' }, textColor: C.text, maxLines: 1, minScale: 0.65 },
            { type: 'spacer' },
            { type: 'text', text: `↓${fmtBytes(d.rxRate)}/s ↑${fmtBytes(d.txRate)}/s`, font: { size: 9, family: 'Menlo', weight: 'bold' }, textColor: C.dim, maxLines: 1, minScale: 0.7 },
          ],
        },
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 4,
          children: [
            { type: 'image', src: 'sf-symbol:network', color: C.text, width: 10, height: 10 },
            { type: 'text', text: d.ipInfo, font: { size: 9, family: 'Menlo', weight: 'bold' }, textColor: C.text, maxLines: 1, minScale: 0.7 },
            { type: 'text', text: '-', font: { size: 9 }, textColor: C.dim },
            { type: 'text', text: d.locInfo, font: { size: 9, weight: 'medium' }, textColor: C.dim, maxLines: 1, minScale: 0.7 },
          ],
        },
        ...rows,
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 4,
          children: [
            { type: 'text', text: `UP ${d.uptime}`, font: { size: 9, weight: 'medium' }, textColor: C.dim, maxLines: 1 },
            { type: 'spacer' },
            { type: 'text', text: `LOAD ${d.load.join(' ')}`, font: { size: 9, family: 'Menlo' }, textColor: C.dim, maxLines: 1, minScale: 0.75 },
          ],
        },
      ],
    };
  };

  if (servers.length === 0) {
    return {
      type: 'widget',
      backgroundColor: C.bg,
      padding: [14, 16],
      gap: 8,
      children: [
        { type: 'text', text: 'Multi Server Monitor', font: { size: 'headline', weight: 'bold' }, textColor: C.text },
        { type: 'text', text: '请配置 SERVER_COUNT，并至少填入 SERVER_1_HOST / SERVER_1_USER / SERVER_1_PASSWORD 或 SERVER_1_KEY', font: { size: 'caption1' }, textColor: C.dim, maxLines: 3 },
      ],
    };
  }

  const results = await Promise.all(servers.map(runProbe));
  const family = String(ctx.widgetFamily || '').toLowerCase();
  const isSmall = family.includes('small');
  const compact = isSmall || family.includes('medium');

  if (isSmall) {
    return {
      type: 'widget',
      backgroundColor: C.bg,
      padding: [12, 14],
      gap: 6,
      children: [
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 5,
          children: [
            { type: 'image', src: 'sf-symbol:rectangle.split.2x1', color: C.text, width: 12, height: 12 },
            { type: 'text', text: `Multi Probe · ${results.length}`, font: { size: 'subheadline', weight: 'bold' }, textColor: C.text },
            { type: 'spacer' },
            { type: 'text', text: timeStr.slice(0, 5), font: { size: 9, family: 'Menlo' }, textColor: C.dim },
          ],
        },
        ...results.map(denseServerLine),
      ],
    };
  }

  const isMedium = family.includes('medium');
  if (results.length > 2) {
    const useTwoColumns = !isMedium && results.length >= 3;
    const rows = [];
    if (useTwoColumns) {
      for (let i = 0; i < results.length; i += 2) {
        const left = compactServerLine(results[i]);
        const right = results[i + 1] ? compactServerLine(results[i + 1]) : { type: 'spacer', flex: 1 };
        rows.push({
          type: 'stack',
          direction: 'row',
          gap: 8,
          children: [
            { ...left, flex: 1 },
            { ...right, flex: 1 },
          ],
        });
      }
    } else {
      rows.push(...results.map(compactServerLine));
    }

    return {
      type: 'widget',
      backgroundColor: C.bg,
      padding: [12, 14],
      gap: 7,
      children: [
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 5,
          children: [
            { type: 'image', src: 'sf-symbol:server.rack', color: C.text, width: 14, height: 14 },
            { type: 'text', text: `Multi Server Monitor · ${results.length}`, font: { size: 'headline', weight: 'bold' }, textColor: C.text, maxLines: 1, minScale: 0.75 },
            { type: 'spacer' },
            { type: 'image', src: 'sf-symbol:arrow.triangle.2.circlepath', color: C.dim, width: 9, height: 9 },
            { type: 'text', text: ` ${timeStr}`, font: { size: 9, family: 'Menlo', weight: 'medium' }, textColor: C.dim },
          ],
        },
        ...rows,
      ],
    };
  }

  return {
    type: 'widget',
    backgroundColor: C.bg,
    padding: [12, 14],
    gap: compact ? 7 : 8,
    children: [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 5,
        children: [
          { type: 'image', src: 'sf-symbol:server.rack', color: C.text, width: 14, height: 14 },
          { type: 'text', text: `Multi Server Monitor · ${results.length}`, font: { size: 'headline', weight: 'bold' }, textColor: C.text },
          { type: 'spacer' },
          { type: 'image', src: 'sf-symbol:arrow.triangle.2.circlepath', color: C.dim, width: 9, height: 9 },
          { type: 'text', text: ` ${timeStr}`, font: { size: 9, family: 'Menlo', weight: 'medium' }, textColor: C.dim },
        ],
      },
      ...results.map(d => serverBlock(d, compact)),
    ],
  };
}
