import express from 'express';
import cors from 'cors';
import ytdl from 'ytdl-core';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(__dirname + '/public'));

function extractVideoId(input) {
  if (!input) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const p of patterns) {
    const m = input.trim().match(p);
    if (m) return m[1];
  }
  return null;
}

// Search
app.get('/api/youtube/search', async (req, res) => {
  const { q, maxResults = 12 } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });
  try {
    const html = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' } }
    ).then(r => r.text());

    const match = html.match(/var ytInitialData = ({.+?});<\/script>/s);
    if (!match) return res.status(500).json({ error: 'Could not parse YouTube results' });

    const items = JSON.parse(match[1])
      ?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents ?? [];

    const results = [];
    for (const item of items) {
      if (results.length >= Number(maxResults)) break;
      const vr = item?.videoRenderer;
      if (!vr?.videoId) continue;
      results.push({
        id: vr.videoId,
        title: vr.title?.runs?.[0]?.text || '',
        thumbnail: vr.thumbnail?.thumbnails?.at(-1)?.url || `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`,
        channelTitle: vr.ownerText?.runs?.[0]?.text || vr.longBylineText?.runs?.[0]?.text || '',
        publishedAt: vr.publishedTimeText?.simpleText || '',
        duration: vr.lengthText?.simpleText || '',
        viewCount: vr.viewCountText?.simpleText || ''
      });
    }
    res.json({ results });
  } catch (e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

// Video info
app.get('/api/youtube/info', async (req, res) => {
  const id = extractVideoId(req.query.url);
  if (!id) return res.status(400).json({ error: 'Invalid YouTube URL or video ID', hasStream: false });
  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${id}`, {
      requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' } }
    });
    const avFormats = info.formats.filter(f => f.hasVideo && f.hasAudio && f.qualityLabel);
    const seen = new Set();
    const qualities = [];
    for (const f of avFormats.sort((a,b) => parseInt(b.qualityLabel) - parseInt(a.qualityLabel))) {
      if (!seen.has(f.qualityLabel)) { seen.add(f.qualityLabel); qualities.push({ itag: f.itag, quality: f.qualityLabel, hasAudio: true }); }
    }
    if (!qualities.length) {
      const fallback = ytdl.chooseFormat(info.formats, { quality: 'highest' });
      if (fallback) qualities.push({ itag: fallback.itag, quality: fallback.qualityLabel || 'Auto', hasAudio: fallback.hasAudio ?? false });
    }
    res.json({ title: info.videoDetails.title, author: info.videoDetails.author?.name || '', quality: qualities[0]?.quality || null, hasStream: qualities.length > 0, qualities });
  } catch (e) {
    console.error('Info error:', e.message);
    res.status(500).json({ error: e.message.includes('private') || e.message.includes('unavailable') ? 'This video is private or unavailable.' : 'Could not load video. Make sure it is public.', hasStream: false });
  }
});

// Stream
app.get('/api/youtube/stream', async (req, res) => {
  const id = extractVideoId(req.query.url);
  const itag = req.query.itag ? parseInt(req.query.itag) : undefined;
  if (!id) return res.status(400).json({ error: 'Invalid URL' });
  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${id}`, {
      requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' } }
    });
    let format = itag ? info.formats.find(f => f.itag === itag) : null;
    if (!format) format = ytdl.chooseFormat(info.formats, { quality: 'highestvideo', filter: 'audioandvideo' });
    if (!format) format = ytdl.chooseFormat(info.formats, { quality: 'highest' });
    if (!format) return res.status(404).json({ error: 'No format found' });

    const mime = (format.mimeType || 'video/mp4').split(';')[0];
    const len = format.contentLength ? parseInt(format.contentLength) : null;
    const range = req.headers.range;

    if (range && len) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr);
      const end = endStr ? parseInt(endStr) : len - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${len}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mime });
      ytdl.downloadFromInfo(info, { format, begin: start }).pipe(res);
    } else {
      const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
      if (len) headers['Content-Length'] = len;
      res.writeHead(200, headers);
      ytdl.downloadFromInfo(info, { format }).pipe(res);
    }
  } catch (e) {
    console.error('Stream error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
  }
});

// Serve frontend for all other routes
app.get('*', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`SafeShare running on port ${PORT}`));
