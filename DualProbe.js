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
    bg: '#140F0C',
    panelBg: '#231D17',
    cardBorder: '#4A4035',
    barBg: '#37322C',
    text: '#F6F2EC',
    dim: '#B9B0A6',
    faint: '#54483C',
    green: '#35B779',
    orange: '#FF9D4D',
    red: '#FF5D55',
    okBg: '#1F432F',
    okText: '#47E290',
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

  const throughputPct = (rxRate, txRate) => {
    const rate = Math.max(0, Number(rxRate) || 0) + Math.max(0, Number(txRate) || 0);
    if (rate <= 0) return 0;
    return Math.min(100, Math.round(Math.log10(rate + 1) * 10));
  };

  const throughputText = (d) => `${fmtBytes((d.rxRate || 0) + (d.txRate || 0))}/s`;

  const trafficTotalText = (d) => `↑ ${fmtBytes(d.netTx || 0)} ↓ ${fmtBytes(d.netRx || 0)}`;
  const networkRateText = (d) => `↑ ${fmtBytes(d.txRate || 0)}/s ↓ ${fmtBytes(d.rxRate || 0)}/s`;
  const usageColor = (pct, fallback) => {
    if (pct >= 80) return C.red;
    if (pct >= 60) return C.orange;
    return fallback || C.green;
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
        "sh -c '. /etc/os-release 2>/dev/null; printf \"%s / %s\" \"${NAME:-Linux}\" \"$(uname -m)\"'",
        "curl -s -m 2 http://ip-api.com/line?fields=country,countryCode,city,query || echo ''",
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
      const osInfo = p[7] || 'Linux';

      let ipInfo = server.host;
      let locInfo = '未知';
      let countryCode = '';
      const ipApiLines = (p[8] || '').split('\n').map(s => s.trim()).filter(Boolean);
      if (ipApiLines.length >= 4) {
        countryCode = ipApiLines[1] || '';
        locInfo = `${ipApiLines[0]} ${ipApiLines[2]}`.replace(/United States/g, 'US').replace(/United Kingdom/g, 'UK');
        ipInfo = ipApiLines[3];
      } else if (ipApiLines.length >= 3) {
        locInfo = `${ipApiLines[0]} ${ipApiLines[1]}`.replace(/United States/g, 'US').replace(/United Kingdom/g, 'UK');
        ipInfo = ipApiLines[2];
      }

      const nn = (p[9] || '0 0').split(' ');
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
        osInfo,
        rxRate,
        txRate,
        netRx,
        netTx,
        netPct: throughputPct(rxRate, txRate),
        ipInfo,
        locInfo,
        countryCode,
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

  const flagEmoji = (code) => {
    const cc = String(code || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) return '▣';
    return String.fromCodePoint(...[...cc].map(c => 127397 + c.charCodeAt(0)));
  };

  const bar = (pct, color, h = 4) => {
    const fill = Math.max(0, Math.min(100, Number(pct) || 0));
    return {
      type: 'stack',
      direction: 'row',
      height: h,
      borderRadius: h / 2,
      backgroundColor: C.barBg,
      children: [
        { type: 'stack', flex: Math.max(0.1, fill), height: h, borderRadius: h / 2, backgroundColor: color, children: [] },
        ...(fill < 100 ? [{ type: 'stack', flex: Math.max(0.1, 100 - fill), children: [] }] : []),
      ],
    };
  };

  const divider = () => ({
    type: 'stack',
    height: 1,
    backgroundColor: C.faint,
    children: [{ type: 'spacer' }],
  });

  const labelValueRow = (label, value, opts = {}) => ({
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: opts.gap || 4,
    ...(opts.height ? { height: opts.height } : {}),
    children: [
      { type: 'text', text: label, font: { size: opts.labelSize || 9, weight: 'medium' }, textColor: C.dim, maxLines: 1, minScale: 0.7 },
      { type: 'spacer' },
      { type: 'text', text: value, font: { size: opts.valueSize || 10, weight: opts.weight || 'bold', family: opts.mono ? 'Menlo' : undefined }, textColor: opts.color || C.text, maxLines: 1, minScale: opts.minScale || 0.45 },
    ],
  });

  const metricLine = (label, pct, value, color, dense) => ({
    type: 'stack',
    direction: 'column',
    gap: dense ? 1 : 2,
    height: dense ? 13 : 16,
    children: [
      labelValueRow(label, value, { labelSize: dense ? 7 : 9, valueSize: dense ? 7 : 9, color, mono: true, height: dense ? 8 : 10 }),
      bar(pct, color, dense ? 3 : 4),
    ],
  });

  const metricLines = (d, dense) => [
    metricLine('CPU', d.cpuPct, `${d.cpuPct}%`, usageColor(d.cpuPct, C.green), dense),
    metricLine('MEM', d.memPct, `${d.memPct}%`, usageColor(d.memPct, C.green), dense),
    metricLine('TRAF', d.netPct, throughputText(d), C.green, dense),
    metricLine('DSK', d.diskPct, `${d.diskPct}%`, usageColor(d.diskPct, C.green), dense),
  ];

  const serverTile = (d, opts = {}) => {
    const compactTile = !!opts.compactTile;
    const tinyTile = !!opts.tinyTile;
    const dense = compactTile || tinyTile;
    const pad = tinyTile ? [5, 6] : compactTile ? [7, 7] : [10, 10];
    const titleSize = tinyTile ? 9 : compactTile ? 10 : 13;
    const statusSize = tinyTile ? 7 : compactTile ? 8 : 9;
    const headerIcon = tinyTile ? 13 : compactTile ? 15 : 18;
    const cardGap = tinyTile ? 2 : compactTile ? 3 : 5;
    const metaSize = tinyTile ? 7 : compactTile ? 7 : 9;
    const cardRadius = 8;

    const cardShell = (children) => ({
      type: 'stack',
      direction: 'column',
      flex: 1,
      padding: [1, 1],
      borderRadius: cardRadius + 1,
      backgroundColor: C.cardBorder,
      children: [
        {
          type: 'stack',
          direction: 'column',
          flex: 1,
          gap: cardGap,
          padding: pad,
          borderRadius: cardRadius,
          backgroundColor: C.panelBg,
          children,
        },
      ],
    });

    if (!d.ok) {
      return cardShell([
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 5,
          height: tinyTile ? 13 : 16,
          children: [
            { type: 'image', src: 'sf-symbol:xmark.octagon.fill', color: C.red, width: headerIcon, height: headerIcon },
            { type: 'text', text: d.hostname, font: { size: titleSize, weight: 'bold' }, textColor: C.text, maxLines: 1, minScale: 0.45 },
            { type: 'spacer' },
            { type: 'text', text: '离线', font: { size: statusSize, weight: 'bold' }, textColor: C.red, maxLines: 1 },
          ],
        },
        divider(),
        { type: 'text', text: d.error, font: { size: metaSize }, textColor: C.dim, maxLines: tinyTile ? 2 : 3, minScale: 0.45 },
      ]);
    }

    return cardShell([
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: tinyTile ? 3 : 5,
        height: tinyTile ? 13 : compactTile ? 16 : 20,
        children: [
          { type: 'text', text: flagEmoji(d.countryCode), font: { size: tinyTile ? 12 : 15 }, textColor: C.text, maxLines: 1 },
          { type: 'text', text: d.hostname, font: { size: titleSize, weight: 'bold' }, textColor: C.text, maxLines: 1, minScale: 0.38 },
          { type: 'spacer' },
          { type: 'image', src: 'sf-symbol:arrow.up.right', color: C.orange, width: tinyTile ? 7 : 9, height: tinyTile ? 7 : 9 },
          { type: 'text', text: '在线', font: { size: statusSize, weight: 'bold' }, textColor: C.okText, backgroundColor: C.okBg, padding: tinyTile ? [1, 4] : [2, 5], borderRadius: 4, maxLines: 1 },
        ],
      },
      divider(),
      ...(tinyTile ? [] : [
        labelValueRow('OS', d.osInfo, { labelSize: metaSize, valueSize: metaSize, minScale: 0.35, height: dense ? 9 : 12 }),
      ]),
      ...metricLines(d, dense),
      ...(tinyTile ? [
        labelValueRow('NET', throughputText(d), { labelSize: metaSize, valueSize: metaSize, mono: true, minScale: 0.4, height: 8 }),
      ] : [
        labelValueRow('总流量', trafficTotalText(d), { labelSize: metaSize, valueSize: metaSize, mono: true, minScale: 0.35, height: dense ? 9 : 12 }),
        labelValueRow('网络', networkRateText(d), { labelSize: metaSize, valueSize: metaSize, mono: true, minScale: 0.35, height: dense ? 9 : 12 }),
        labelValueRow('运行时间', d.uptime, { labelSize: metaSize, valueSize: metaSize, mono: true, minScale: 0.35, height: dense ? 9 : 12 }),
      ]),
    ]);
  };

  const tileRows = (items, columns, compactTile, tinyTile) => {
    const rows = [];
    for (let i = 0; i < items.length; i += columns) {
      const children = [];
      for (let j = 0; j < columns; j++) {
        const item = items[i + j];
        children.push(item ? { ...serverTile(item, { compactTile, tinyTile }), flex: 1 } : { type: 'spacer', flex: 1 });
      }
      rows.push({ type: 'stack', direction: 'row', flex: 1, gap: tinyTile ? 5 : 7, children });
    }
    return rows;
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
  const isMedium = family.includes('medium');
  const isLarge = family.includes('large');
  const count = results.length;

  let padding = [8, 8];
  let gap = 6;
  let columns = 1;
  let compactTile = true;
  let tinyTile = false;

  if (isSmall) {
    padding = [5, 5];
    gap = 4;
    columns = 1;
    compactTile = true;
    tinyTile = count > 1;
  } else if (isMedium) {
    padding = [4, 5];
    gap = 5;
    columns = count === 1 ? 1 : 2;
    compactTile = true;
    tinyTile = count > 2;
  } else if (isLarge) {
    padding = [7, 7];
    gap = 6;
    columns = count === 1 ? 1 : 2;
    compactTile = count > 1;
    tinyTile = count > 4;
  } else {
    columns = count === 1 ? 1 : 2;
    compactTile = count > 1;
    tinyTile = count > 4;
  }

  return {
    type: 'widget',
    backgroundColor: C.bg,
    padding,
    gap,
    children: tileRows(results, columns, compactTile, tinyTile),
  };
}
