const fs = require('fs')
const http = require('http')
const format = require('util').format

const WebSocket = require('ws')
const finalHttpHandler = require('finalhandler')
const serveStatic = require('serve-static')

const logger = require('./logger')
const config = require('../config')

const STRINGS = require('../assets/i18n/strings.json')

const HASHED_FAVICON_URL_REGEX = /hashedfavicon_([a-z0-9]{32}).png/g
const MAX_PROPOSAL_BODY_BYTES = 8 * 1024
const MAX_PROPOSALS_PER_HOUR = 3
const PROPOSAL_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000

function getProposalWebhookUrl () {
  if (!config.serverProposalWebhookUrl) {
    return undefined
  }

  try {
    const url = new URL(config.serverProposalWebhookUrl)
    const isDiscordWebhook = url.protocol === 'https:' &&
      ['discord.com', 'discordapp.com'].includes(url.hostname) &&
      /^\/api\/webhooks\/\d+\/[\w-]+$/.test(url.pathname)

    if (isDiscordWebhook) {
      return url.toString()
    }
  } catch (err) {}

  logger.log('warn', 'serverProposalWebhookUrl is not a valid Discord webhook URL; server proposals are disabled')
  return undefined
}

const PROPOSAL_WEBHOOK_URL = getProposalWebhookUrl()

// Small, unhashed static assets served at fixed URLs (SEO metadata, robots.txt, etc.)
// These are kept separate from the Parcel-built `dist/` bundle so their URLs stay stable
const STATIC_ASSETS = {
  '/robots.txt': { file: 'assets/static/robots.txt', contentType: 'text/plain' },
  '/og-image.png': { file: 'assets/images/og-image.png', contentType: 'image/png' }
}

for (const asset of Object.values(STATIC_ASSETS)) {
  asset.buffer = fs.readFileSync(asset.file)
}

function renderTemplate (template, tokens) {
  return template.replace(/{{(\w+)}}/g, (match, key) => Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : match)
}

function buildServerProposalMarkup (strings) {
  if (!PROPOSAL_WEBHOOK_URL) {
    return { button: '', form: '' }
  }

  return {
    button: `<button id="server-proposal-toggle" class="header-button" type="button" style="margin-left: 20px;"><span class="icon-street-view"></span> ${strings.serverProposalButton}</button>`,
    form: `<div id="server-proposal-backdrop" hidden></div>
    <section id="server-proposal" role="dialog" aria-modal="true" aria-labelledby="server-proposal-title" data-nosnippet hidden>
      <h2 id="server-proposal-title">${strings.serverProposalTitle}</h2>
      <p>${strings.serverProposalIntro}</p>
      <form id="server-proposal-form">
        <label class="server-proposal-field">${strings.serverProposalName}
          <input id="server-proposal-name" name="name" maxlength="100" required>
        </label>
        <label class="server-proposal-field">${strings.serverProposalAddress}
          <input name="address" maxlength="255" placeholder="play.example.se" required>
        </label>
        <label class="server-proposal-field">${strings.serverProposalWebsite}
          <input name="website" type="url" maxlength="500" placeholder="https://example.se">
        </label>
        <label class="server-proposal-field">${strings.serverProposalNotes}
          <textarea name="notes" maxlength="1000"></textarea>
        </label>
        <div class="server-proposal-actions">
          <button id="server-proposal-submit" class="button" type="submit">${strings.serverProposalSubmit}</button>
          <button id="server-proposal-cancel" class="button button-secondary" type="button">${strings.serverProposalCancel}</button>
        </div>
        <p id="server-proposal-status" class="server-proposal-status" aria-live="polite" data-success="${strings.serverProposalSuccess}" data-error="${strings.serverProposalError}"></p>
      </form>
    </section>`
  }
}

function buildLocalePage (indexHtmlTemplate, locale, canonicalPath) {
  const strings = STRINGS[locale]
  const serverProposal = buildServerProposalMarkup(strings)

  const subtitle = strings.subtitle
    .replace('{statNetworks}', '<span class="global-stat" id="stat_networks">live</span>')
    .replace('{statTotalPlayers}', '<span class="global-stat" id="stat_totalPlayers">current</span>')

  const footerPoweredBy = strings.footerPoweredBy
    .replace('{link}', '<a href="https://github.com/Sup33r/Minetrack">Minetrack</a>')

  const html = renderTemplate(indexHtmlTemplate, {
    htmlLang: locale,
    // canonicalPath is embedded in the HTML source after a literal "https://minetrack.nu"
    // prefix so Parcel's HTML transformer recognizes the <link>/<a> hrefs as absolute
    // external URLs and doesn't try to resolve them as bundleable local assets
    canonicalPath,
    canonicalUrl: `https://minetrack.nu${canonicalPath}`,
    title: strings.title,
    metaDescription: strings.metaDescription,
    siteNameStructuredData: canonicalPath === '/'
      ? '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Minetrack Sweden","alternateName":["Minetrack","minetrack.nu"],"url":"https://minetrack.nu/"}</script>'
      : '',
    statusConnecting: strings.statusConnecting,
    subtitle,
    sortByLabel: strings.sortByLabel,
    playersLabel: strings.playersLabel,
    graphControlsLabel: strings.graphControlsLabel,
    showAll: strings.showAll,
    hideAll: strings.hideAll,
    onlyFavorites: strings.onlyFavorites,
    footerPoweredBy,
    langToggleHref: locale === 'en' ? '/sv' : '/en',
    switchLanguageLabel: strings.switchLanguageLabel,
    langToggleLabel: strings.languageToggleLabel,
    serverProposalButton: serverProposal.button,
    serverProposalForm: serverProposal.form
  })

  return Buffer.from(html)
}

const indexHtmlTemplate = fs.readFileSync('dist/index.html', 'utf8')

const PAGE_ROUTES = {
  '/': buildLocalePage(indexHtmlTemplate, 'en', '/'),
  '/en': buildLocalePage(indexHtmlTemplate, 'en', '/en'),
  '/sv': buildLocalePage(indexHtmlTemplate, 'sv', '/sv')
}

function getRemoteAddr (req) {
  return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress
}

class Server {
  static getHashedFaviconUrl (hash) {
    // Format must be compatible with HASHED_FAVICON_URL_REGEX
    return format('/hashedfavicon_%s.png', hash)
  }

  constructor (app) {
    this._app = app
    this._proposalSubmissionTimes = new Map()

    this.createHttpServer()
    this.createWebSocketServer()
  }

  createHttpServer () {
    const distServeStatic = serveStatic('dist/', {
      maxAge: '1y',
      immutable: true,
      setHeaders: (res, path) => {
        if (path.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
        }
      }
    })
    const faviconsServeStatic = serveStatic('favicons/')

    this._http = http.createServer((req, res) => {
      logger.log('info', '%s requested: %s', getRemoteAddr(req), req.url)

      // Handle API endpoint for stats
      if (req.url === '/api/stats' || req.url === '/api/stats/') {
        this.handleStatsRequest(req, res)
        return
      }

      if (req.url === '/api/server-proposals') {
        this.handleServerProposalRequest(req, res)
        return
      }

      // Handle fixed-URL static assets (robots.txt, apple touch icon, og:image, ...)
      if (this.handleStaticAssetRequest(req, res)) {
        return
      }

      // Redirect trailing-slash locale URLs to their canonical non-trailing-slash form
      if (req.url === '/en/' || req.url === '/sv/') {
        res.writeHead(301, { Location: req.url.slice(0, -1) }).end()
        return
      }

      if (req.url === '/index.html') {
        res.writeHead(301, { Location: '/' }).end()
        return
      }

      // Handle localized page requests (/, /en, /sv)
      if (this.handleLocalePageRequest(req, res)) {
        return
      }

      // Test the URL against a regex for hashed favicon URLs
      // Require only 1 match ([0]) and test its first captured group ([1])
      // Any invalid value or hit miss will pass into static handlers below
      const faviconHash = [...req.url.matchAll(HASHED_FAVICON_URL_REGEX)]

      if (faviconHash.length === 1 && this.handleFaviconRequest(res, faviconHash[0][1])) {
        return
      }

      // Attempt to handle req using distServeStatic, otherwise fail over to faviconServeStatic
      // If faviconServeStatic fails, pass to finalHttpHandler to terminate
      distServeStatic(req, res, () => {
        faviconsServeStatic(req, res, finalHttpHandler(req, res))
      })
    })
  }

  handleStatsRequest = (req, res) => {
    const stats = {
      timestamp: Date.now(),
      totalPlayers: 0,
      servers: []
    }

    for (const serverRegistration of this._app.serverRegistrations) {
      const serverData = {
        name: serverRegistration.data.name,
        ip: serverRegistration.data.ip,
        type: serverRegistration.data.type,
        color: serverRegistration.data.color,
        playerCount: null,
        versions: serverRegistration.versions.slice(),
        recordData: serverRegistration.recordData,
        graphPeakData: serverRegistration.getGraphPeak(),
        favicon: serverRegistration.getFaviconUrl()
      }

      if (serverRegistration._pingHistory && serverRegistration._pingHistory.length > 0) {
        serverData.playerCount = serverRegistration._pingHistory[serverRegistration._pingHistory.length - 1]
        if (serverData.playerCount !== null) {
          stats.totalPlayers += serverData.playerCount
        }
      }

      stats.servers.push(serverData)
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(JSON.stringify(stats, null, 2))
  }

  handleServerProposalRequest = async (req, res) => {
    if (!PROPOSAL_WEBHOOK_URL) {
      this.sendJson(res, 404, { error: 'Server proposals are not enabled' })
      return
    }

    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' })
      return
    }

    const remoteAddr = getRemoteAddr(req)
    if (!this.canSubmitProposal(remoteAddr)) {
      this.sendJson(res, 429, { error: 'Too many proposals submitted' })
      return
    }

    try {
      const proposal = await this.readServerProposal(req)
      this.recordProposalSubmission(remoteAddr)
      await this.sendProposalToDiscord(proposal)
      this.sendJson(res, 201, { success: true })
    } catch (err) {
      if (err.statusCode) {
        this.sendJson(res, err.statusCode, { error: err.message })
      } else {
        logger.log('warn', 'Unable to send server proposal to Discord: %s', err.message)
        this.sendJson(res, 502, { error: 'Unable to send proposal' })
      }
    }
  }

  readServerProposal = (req) => {
    return new Promise((resolve, reject) => {
      let body = ''
      let bodySize = 0

      req.on('data', (chunk) => {
        bodySize += chunk.length
        if (bodySize <= MAX_PROPOSAL_BODY_BYTES) {
          body += chunk
        }
      })

      req.on('end', () => {
        if (bodySize > MAX_PROPOSAL_BODY_BYTES) {
          reject(Object.assign(new Error('Proposal is too large'), { statusCode: 413 }))
          return
        }

        try {
          const data = JSON.parse(body)
          const proposal = {
            name: this.getProposalField(data.name, 100),
            address: this.getProposalField(data.address, 255),
            website: this.getProposalField(data.website, 500),
            notes: this.getProposalField(data.notes, 1000)
          }

          if (!proposal.name || !proposal.address) {
            reject(Object.assign(new Error('Server name and address are required'), { statusCode: 400 }))
            return
          }

          if (proposal.website) {
            const websiteUrl = new URL(proposal.website)
            if (!['http:', 'https:'].includes(websiteUrl.protocol)) {
              throw new Error('Invalid website URL')
            }
          }

          resolve(proposal)
        } catch (err) {
          reject(Object.assign(new Error('Invalid proposal data'), { statusCode: 400 }))
        }
      })

      req.on('error', () => reject(Object.assign(new Error('Unable to read proposal'), { statusCode: 400 })))
    })
  }

  getProposalField = (value, maxLength) => {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
  }

  sendProposalToDiscord = async (proposal) => {
    const fields = [
      { name: 'Server name', value: proposal.name, inline: true },
      { name: 'Server address', value: proposal.address, inline: true }
    ]

    if (proposal.website) {
      fields.push({ name: 'Website', value: proposal.website })
    }

    if (proposal.notes) {
      fields.push({ name: 'Notes', value: proposal.notes })
    }

    const response = await fetch(PROPOSAL_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Minetrack',
        allowed_mentions: { parse: [] },
        embeds: [{
          title: 'New server proposal',
          color: 0x6c5ce7,
          fields,
          timestamp: new Date().toISOString()
        }]
      })
    })

    if (!response.ok) {
      throw new Error(`Discord returned ${response.status}`)
    }
  }

  canSubmitProposal = (remoteAddr) => {
    const now = Date.now()
    const submissionTimes = (this._proposalSubmissionTimes.get(remoteAddr) || [])
      .filter(timestamp => timestamp > now - PROPOSAL_RATE_LIMIT_WINDOW_MS)

    this._proposalSubmissionTimes.set(remoteAddr, submissionTimes)
    return submissionTimes.length < MAX_PROPOSALS_PER_HOUR
  }

  recordProposalSubmission = (remoteAddr) => {
    const submissionTimes = this._proposalSubmissionTimes.get(remoteAddr) || []
    submissionTimes.push(Date.now())
    this._proposalSubmissionTimes.set(remoteAddr, submissionTimes)
  }

  sendJson = (res, statusCode, payload) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }

  handleStaticAssetRequest = (req, res) => {
    const asset = STATIC_ASSETS[req.url]

    if (!asset) {
      return false
    }

    res.writeHead(200, {
      'Content-Type': asset.contentType,
      'Content-Length': asset.buffer.length,
      'Cache-Control': 'public, max-age=86400'
    }).end(asset.buffer)

    return true
  }

  handleLocalePageRequest = (req, res) => {
    const page = PAGE_ROUTES[req.url]

    if (!page) {
      return false
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': page.length,
      'Content-Language': req.url === '/sv' ? 'sv' : 'en',
      'Cache-Control': 'public, max-age=0, must-revalidate'
    }).end(page)

    return true
  }

  handleFaviconRequest = (res, faviconHash) => {
    for (const serverRegistration of this._app.serverRegistrations) {
      if (serverRegistration.faviconHash && serverRegistration.faviconHash === faviconHash) {
        const buf = Buffer.from(serverRegistration.lastFavicon.split(',')[1], 'base64')

        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=604800' // Cache hashed favicon for 7 days
        }).end(buf)

        return true
      }
    }

    return false
  }

  createWebSocketServer () {
    this._wss = new WebSocket.Server({
      server: this._http
    })

    this._wss.on('connection', (client, req) => {
      logger.log('info', '%s connected, total clients: %d', getRemoteAddr(req), this.getConnectedClients())

      // Bind disconnect event for logging
      client.on('close', () => {
        logger.log('info', '%s disconnected, total clients: %d', getRemoteAddr(req), this.getConnectedClients())
      })

      // Pass client off to proxy handler
      this._app.handleClientConnection(client)
    })
  }

  listen (host, port) {
    this._http.listen(port, host)

    logger.log('info', 'Started on %s:%d', host, port)
  }

  broadcast (payload) {
    this._wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload)
      }
    })
  }

  getConnectedClients () {
    let count = 0
    this._wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        count++
      }
    })
    return count
  }
}

module.exports = Server
