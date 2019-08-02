/**
 * @module html
 */

import { getLogger } from '@stencila/logga'
import stencila from '@stencila/schema'
import { isArticle, nodeType, markTypes } from '@stencila/schema/dist/util'
import collapse from 'collapse-whitespace'
import escape from 'escape-html'
import fs from 'fs'
// @ts-ignore
import GithubSlugger from 'github-slugger'
import h from 'hyperscript'
// @ts-ignore
import { html as beautifyHtml } from 'js-beautify'
import jsdom from 'jsdom'
import JSON5 from 'json5'
import path from 'path'
import { Encode, EncodeOptions } from '../..'
import { columnIndexToName } from '../../codecs/xlsx'
import bundle from '../../util/bundle'
import * as vfile from '../../util/vfile'

const document = new jsdom.JSDOM().window.document

const log = getLogger('encoda:html')

// Ensures unique `id` attributes (e.g. for headings)
const slugger = new GithubSlugger()

export const mediaTypes = ['text/html']

/**
 * Decode a `VFile` with HTML contents to a `stencila.Node`.
 *
 * @param file The `VFile` to decode
 * @returns A promise that resolves to a `stencila.Node`
 */
export async function decode(file: vfile.VFile): Promise<stencila.Node> {
  const html = await vfile.dump(file)
  const dom = new jsdom.JSDOM(html)
  const document = dom.window.document
  collapse(document)
  const node = decodeNode(document)
  if (!node) throw new Error(`Unable to decode HTML`)
  return node
}

export const beautify = (html: string): string =>
  /* eslint-disable @typescript-eslint/camelcase */
  beautifyHtml(html, {
    indent_size: 2,
    indent_inner_html: true, // Indent <head> and <body> sections
    wrap_line_length: 100,
    preserve_newlines: false // Preserve existing line-breaks
  })
/* eslint-enable @typescript-eslint/camelcase */

const getArticleMetaData = (
  node: stencila.Node
): Exclude<stencila.Article, 'content'> => {
  if (isArticle(node)) {
    const { content, ...metadata } = node
    return metadata
  }

  return {
    authors: [],
    title: 'Untitled',
    type: 'Article'
  }
}

/**
 * Encode a `stencila.Node` to a `VFile` with HTML contents.
 *
 * @param node The `stencila.Node` to encode. Will be mutated to an `Node`.
 * @returns A promise that resolves to a `VFile`
 */
export const encode: Encode = async (
  node: stencila.Node,
  options: EncodeOptions = {}
): Promise<vfile.VFile> => {
  const { isStandalone = true, isBundle = false, theme = 'stencila' } = options

  // Reset the slugger to avoid unnecessarily adding numbers to ids
  // in order to make them unique
  slugger.reset()

  const nodeToEncode = isBundle ? await bundle(node) : node
  let dom: HTMLHtmlElement = encodeNode(nodeToEncode, {
    isStandalone,
    theme
  }) as HTMLHtmlElement

  if (isStandalone) {
    const { title, ...metadata } = getArticleMetaData(node)
    dom = generateHtmlElement(title, metadata, [dom], options)
  }

  const beautifulHtml = beautify(dom.outerHTML)
  return vfile.load(beautifulHtml)
}

function decodeNode(node: Node): stencila.Node | undefined {
  const name = node.nodeName.toLowerCase()
  switch (name) {
    case '#document':
      return decodeDocument(node as HTMLDocument)

    case 'article':
      return decodeArticle(node as HTMLElement)

    case 'div':
      return decodeDiv(node as HTMLDivElement)

    case 'p':
      return decodeParagraph(node as HTMLParagraphElement)
    case 'blockquote':
      return decodeBlockquote(node as HTMLQuoteElement)
    case 'pre':
      if (node.firstChild && node.firstChild.nodeName === 'CODE') {
        return decodeCodeBlock(node as HTMLPreElement)
      }
      break
    case 'ul':
      return decodeList(node as HTMLUListElement)
    case 'ol':
      return decodeList(node as HTMLOListElement)
    case 'li':
      return decodeListItem(node as HTMLLIElement)
    case 'table':
      return decodeTable(node as HTMLTableElement)
    case 'stencila-datatable':
      return decodeDatatable(node as HTMLDivElement)
    case 'hr':
      return decodeHR(node as HTMLHRElement)

    case 'em':
      return decodeMark(node as HTMLElement, 'Emphasis')
    case 'strong':
      return decodeMark(node as HTMLElement, 'Strong')
    case 'del':
      return decodeMark(node as HTMLElement, 'Delete')
    case 'sup':
      return decodeMark(node as HTMLElement, 'Superscript')
    case 'sub':
      return decodeMark(node as HTMLElement, 'Subscript')
    case 'a':
      return decodeLink(node as HTMLAnchorElement)
    case 'q':
      return decodeQuote(node as HTMLQuoteElement)
    case 'code':
      return decodeCode(node as HTMLElement)
    case 'img':
      return decodeImage(node as HTMLImageElement)

    case 'stencila-null':
      return decodeNull(node as HTMLElement)
    case 'stencila-boolean':
      return decodeBoolean(node as HTMLElement)
    case 'stencila-number':
      return decodeNumber(node as HTMLElement)
    case 'stencila-array':
      return decodeArray(node as HTMLElement)
    case 'stencila-object':
      return decodeObject(node as HTMLElement)
    case 'stencila-thing':
      return decodeThing(node as HTMLElement)

    case 'script':
      return undefined

    case '#text':
      return decodeText(node as Text)
  }

  const match = name.match(/^h(\d)$/)
  if (match) {
    return decodeHeading(node as HTMLHeadingElement, parseInt(match[1], 10))
  }

  log.warn(`No handler for HTML element <${name}>`)
  return undefined
}

const encodeNode = (node: stencila.Node, options: {} = {}): Node => {
  switch (nodeType(node)) {
    case 'Article':
      return encodeArticle(node as stencila.Article)

    case 'Include':
      return encodeInclude(node as stencila.Include)

    case 'Heading':
      return encodeHeading(node as stencila.Heading)
    case 'Paragraph':
      return encodeParagraph(node as stencila.Paragraph)
    case 'QuoteBlock':
      return encodeQuoteBlock(node as stencila.QuoteBlock)
    case 'CodeBlock':
      return encodeCodeBlock(node as stencila.CodeBlock)
    case 'CodeChunk':
      return encodeCodeChunk(node as stencila.CodeChunk)
    case 'List':
      return encodeList(node as stencila.List)
    case 'ListItem':
      return encodeListItem(node as stencila.ListItem)
    case 'Table':
      return encodeTable(node as stencila.Table)
    case 'Datatable':
      return encodeDatatable(node as stencila.Datatable)
    case 'ThematicBreak':
      return encodeThematicBreak(node as stencila.ThematicBreak)

    case 'Emphasis':
      return encodeMark(node as stencila.Emphasis, 'em')
    case 'Strong':
      return encodeMark(node as stencila.Strong, 'strong')
    case 'Delete':
      return encodeMark(node as stencila.Strong, 'del')
    case 'Superscript':
      return encodeMark(node as stencila.Superscript, 'sup')
    case 'Subscript':
      return encodeMark(node as stencila.Subscript, 'sub')
    case 'Link':
      return encodeLink(node as stencila.Link)
    case 'Quote':
      return encodeQuote(node as stencila.Quote)
    case 'Code':
      return encodeCode(node as stencila.Code)
    case 'ImageObject':
      return encodeImageObject(node as stencila.ImageObject)
    case 'Math':
      return encodeMath(node as object)

    case 'null':
      return encodeNull(node as null)
    case 'boolean':
      return encodeBoolean(node as boolean)
    case 'number':
      return encodeNumber(node as number)
    case 'string':
      return encodeString(node as string)
    case 'array':
      return encodeArray(node as any[])
    case 'object':
      return encodeObject(node as object)
    default:
      return encodeThing(node as stencila.Thing)
  }
}

function decodeBlockChildNodes(node: Node): stencila.BlockContent[] {
  return Array.from(node.childNodes)
    .map(child => decodeNode(child) as stencila.BlockContent)
    .filter(node => typeof node !== 'undefined')
}

function decodeInlineChildNodes(node: Node): stencila.InlineContent[] {
  return Array.from(node.childNodes)
    .map(child => decodeNode(child) as stencila.InlineContent)
    .filter(node => typeof node !== 'undefined')
}

/**
 * Decode a `#document` node to a `stencila.Node`.
 */
function decodeDocument(doc: HTMLDocument): stencila.Node {
  const head = doc.querySelector('head')
  if (!head) throw new Error('Document does not have a <head>!')

  const body = doc.querySelector('body')
  if (!body) throw new Error('Document does not have a <body>!')

  const jsonld = head.querySelector('script[type="application/ld+json"]')
  const metadata = jsonld ? JSON.parse(jsonld.innerHTML || '{}') : {}
  delete metadata['@context']

  if (!jsonld && body.childElementCount === 1) {
    const node = decodeNode(body.children[0])
    if (!node) throw new Error(`Top level node is not defined`)
    return node
  }

  // TODO: Allow for the different types of creative work based on type in
  // the jsonld
  return {
    type: 'Article',
    ...metadata,
    content: decodeBlockChildNodes(body)
  }
}

/**
 * Decode a `<div>` node to a Stencila `Node`.
 *
 * A `<div>` is treated as having no semantic meaning
 * and so this function decodes it's children.
 */
function decodeDiv(div: HTMLDivElement): stencila.Node | undefined {
  return [...div.childNodes].map(decodeNode)
}

/**
 * Generate a `<html>` element with supplied title, metadata, body content, and
 * optionally custom CSS to style the document with.
 */
function generateHtmlElement(
  title: string = 'Untitled',
  metadata: { [key: string]: any } = {},
  body: Node[] = [],
  options: EncodeOptions = {}
): HTMLHtmlElement {
  const { isBundle = false, theme = 'stencila' } = options

  log.debug(`Generating <html> elem with options ${JSON.stringify(options)}`)

  let themeCss
  let themeJs
  if (isBundle) {
    // Bundle the theme into the document
    const themePath = path.resolve(
      require.resolve('@stencila/thema'),
      '..',
      'themes',
      theme
    )
    themeCss = h('style', {
      innerHTML: fs.readFileSync(path.join(themePath, 'styles.css')).toString()
    })
    themeJs = h('script', {
      innerHTML: fs.readFileSync(path.join(themePath, 'index.js')).toString()
    })
  } else {
    // Add links to the theme to the document
    const themaVersion = require(path.join(
      require.resolve('@stencila/thema'),
      '..',
      '..',
      'package.json'
    )).version

    const themeBaseUrl = `https://unpkg.com/@stencila/thema@${themaVersion}/dist/themes/${theme}`
    themeCss = h('link', {
      href: `${themeBaseUrl}/styles.css`,
      rel: 'stylesheet'
    })
    themeJs = h('script', {
      src: `${themeBaseUrl}/index.js`,
      type: 'text/javascript'
    })
  }

  const jsonld = h(
    'script',
    { type: 'application/ld+json' },
    JSON.stringify({
      '@context': 'http://stencila.github.io/schema/stencila.jsonld',
      ...metadata
    })
  )

  return h(
    'html',
    h(
      'head',
      h('title', title),
      h('meta', { charset: 'utf-8' }),
      h('meta', {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1.0'
      }),
      h('meta', { 'http-equiv': 'X-UA-Compatible', content: 'ie=edge' }),
      jsonld,
      themeCss,
      themeJs
    ),
    h('body', body)
  )
}

/**
 * Decode an `<article>` element to a `Article` node.
 */
const decodeArticle = (element: HTMLElement): stencila.Article => {
  const titleEl = element.querySelector('h1[role=title]')
  const title = titleEl ? titleEl.innerHTML : 'Untitled'
  if (titleEl) titleEl.remove()

  return {
    type: 'Article',
    title,
    authors: [],
    content: [...element.childNodes].reduce((nodes: stencila.Node[], node) => {
      const decodedNode = decodeNode(node)
      return decodedNode ? [...nodes, decodedNode] : nodes
    }, [])
  }
}

/**
 * Encode an `Article` node to a `<article>` element.
 */
function encodeArticle(article: stencila.Article): HTMLElement {
  const { type, title, content, references, ...rest } = article
  const titleEl = h('h1', title)
  titleEl.setAttribute('role', 'title')
  const elements = content ? content.map(encodeNode) : []
  const refs = references ? encodeReferences(references) : []
  return h('article', titleEl, ...elements, refs)
}

function encodeReferences(
  references: (string | stencila.CreativeWork)[]
): HTMLElement {
  return h('section', h('h1', 'References'), ...references.map(encodeReference))
}

function encodeReference(
  citation: string | stencila.CreativeWork
): HTMLElement {
  return typeof citation === 'string'
    ? h('div', citation)
    : encodeCreativeWork(citation)
}

function encodeCreativeWork(work: stencila.CreativeWork): HTMLElement {
  const elem = h(
    'div',
    {
      itemscope: true,
      itemtype: 'http://schema.org/CreativeWork',
      itemprop: 'citation'
    },
    ...(work.authors || []).map(author =>
      author.type === 'Person'
        ? encodePerson(author)
        : encodeOrganization(author)
    ),
    h('span', { itemprop: 'datePublished' }, work.datePublished),
    h('span', { itemprop: 'title' }, work.title)
  )
  elem.setAttribute('itemtype', 'http://schema.org/CreativeWork')
  return elem
}

function encodePerson(person: stencila.Person): HTMLElement {
  const elem = h(
    'span',
    {
      itemscope: true,
      itemtype: 'http://schema.org/Person',
      itemprop: 'author'
    },
    h('span', { itemprop: 'familyName' }, person.familyNames),
    h('span', { itemprop: 'givenName' }, person.givenNames)
  )
  elem.setAttribute('itemtype', 'http://schema.org/Person')
  return elem
}

function encodeOrganization(org: stencila.Organization): HTMLElement {
  return h('div', org.name)
}

/**
 * Encode a Stencila `Include` node to a Microdata `div[itemtype]` element.
 *
 * TODO: This is an initial implementation and it is probably better to generalize
 * it into a default encoding function to replace `encodeThing`.
 */
function encodeInclude(include: stencila.Include): HTMLElement {
  const content = include.content || []
  const contentDiv = h('div', content.map(encodeNode))
  contentDiv.setAttribute('itemprop', 'content')
  const elem = h(`div`, contentDiv)
  elem.setAttribute(
    'itemtype',
    `https://stencila.github.io/schema/${nodeType(include)}`
  )
  return elem
}

/**
 * Decode a `<h1>` etc element to a `stencila.Heading`.
 */
function decodeHeading(
  heading: HTMLHeadingElement,
  depth: number
): stencila.Heading {
  return { type: 'Heading', depth, content: decodeInlineChildNodes(heading) }
}

/**
 * Encode a `stencila.Heading` to a `<h1>` etc element.
 */
function encodeHeading(heading: stencila.Heading): HTMLHeadingElement {
  const content = heading.content.map(encodeNode)
  const text = content.reduce((prev, curr) => `${prev}${curr.textContent}`, '')
  const id = slugger.slug(text)
  return h(`h${heading.depth}`, { id }, content)
}

/**
 * Decode a `<p>` element to a `stencila.Paragraph`.
 */
function decodeParagraph(para: HTMLParagraphElement): stencila.Paragraph {
  return { type: 'Paragraph', content: decodeInlineChildNodes(para) }
}

/**
 * Encode a `stencila.Paragraph` to a `<p>` element.
 */
function encodeParagraph(para: stencila.Paragraph): HTMLParagraphElement {
  return h('p', para.content.map(encodeNode))
}

/**
 * Decode a `<blockquote>` element to a `stencila.QuoteBlock`.
 */
function decodeBlockquote(elem: HTMLQuoteElement): stencila.QuoteBlock {
  const quoteBlock: stencila.QuoteBlock = {
    type: 'QuoteBlock',
    content: decodeBlockChildNodes(elem)
  }
  const cite = elem.getAttribute('cite')
  if (cite) quoteBlock.citation = cite
  return quoteBlock
}

/**
 * Encode a `stencila.QuoteBlock` to a `<blockquote>` element.
 */
function encodeQuoteBlock(block: stencila.QuoteBlock): HTMLQuoteElement {
  return h(
    'blockquote',
    { cite: block.citation },
    block.content.map(encodeNode)
  )
}

/**
 * Decode a `<pre><code class="language-xxx">` element to a `stencila.CodeBlock`.
 */
function decodeCodeBlock(elem: HTMLPreElement): stencila.CodeBlock {
  const code = elem.querySelector('code')
  if (!code) throw new Error('Woaah, this should never happen!')
  const { language, value } = decodeCode(code)
  const codeblock: stencila.CodeBlock = {
    type: 'CodeBlock',
    language,
    value
  }
  const meta = decodeDataAttrs(elem)
  if (meta) codeblock.meta = meta
  return codeblock
}

/**
 * Encode a `stencila.CodeBlock` to a `<pre><code class="language-xxx">` element.
 *
 * If the `CodeBlock` has a `meta` property, any keys are added as attributes to
 * the `<pre>` element with a `data-` prefix.
 */
function encodeCodeBlock(block: stencila.CodeBlock): HTMLPreElement {
  const attrs = encodeDataAttrs(block.meta || {})
  const code = encodeCode(block, false)
  return h('pre', attrs, code)
}

/**
 * Encode a `stencila.CodeChunk` to a `<stencila-codechunk>` element.
 */
function encodeCodeChunk(chunk: stencila.CodeChunk): HTMLElement {
  const attrs = encodeDataAttrs(chunk.meta || {})

  const codeBlock = encodeCodeBlock({
    type: 'CodeBlock',
    value: chunk.text || ''
  })
  // TODO: Until our themes can handle interactive
  codeBlock.setAttribute('style', 'display:none')

  const outputs = h(
    'div',
    { 'data-outputs': true },
    (chunk.outputs || []).map(node => {
      const content = (() => {
        switch (nodeType(node)) {
          case 'string':
            return h('pre', node as string)
          case 'ImageObject':
            return encodeImageObject(node as stencila.ImageObject)
          default:
            return encodeNode(node)
        }
      })()
      return h('figure', content)
    })
  )

  return h('stencila-codechunk', attrs, codeBlock, outputs)
}

/**
 * Decode a `<ul>` or `<ol>` element to a `stencila.List`.
 */
function decodeList(list: HTMLUListElement | HTMLOListElement): stencila.List {
  const order = list.tagName === 'UL' ? 'unordered' : 'ascending'
  return {
    type: 'List',
    order,
    items: [...list.querySelectorAll('li')].map(decodeListItem)
  }
}

/**
 * Encode a `stencila.List` to a `<ul>` or `<ol>` element.
 */
function encodeList(list: stencila.List): HTMLUListElement | HTMLOListElement {
  return h(list.order === 'unordered' ? 'ul' : 'ol', list.items.map(encodeNode))
}

/**
 * Decode a `<li>` element to a `stencila.ListItem`.
 */
function decodeListItem(li: HTMLLIElement): stencila.ListItem {
  return {
    type: 'ListItem',
    // TODO: Extract the callback
    content: [...li.childNodes].reduce((nodes: stencila.Node[], node) => {
      const decodedNode = decodeNode(node)
      return decodedNode !== undefined ? [...nodes, decodedNode] : nodes
    }, [])
  }
}

/**
 * Encode a `stencila.ListItem` to a `<li>` element.
 */
function encodeListItem(listItem: stencila.ListItem): HTMLLIElement {
  return h('li', listItem.content.map(encodeNode))
}

/**
 * Decode a `<table>` element to a `stencila.Table`.
 */
function decodeTable(table: HTMLTableElement): stencila.Table {
  return {
    type: 'Table',
    rows: Array.from(table.querySelectorAll('tr')).map(
      (row: HTMLTableRowElement): stencila.TableRow => {
        return {
          type: 'TableRow',
          cells: Array.from(row.querySelectorAll('td')).map(
            (cell: HTMLTableDataCellElement): stencila.TableCell => {
              return {
                type: 'TableCell',
                content: decodeInlineChildNodes(cell)
              }
            }
          )
        }
      }
    )
  }
}

/**
 * Encode a `stencila.Table` to a `<table>` element.
 */
function encodeTable(table: stencila.Table): HTMLTableElement {
  // prettier-ignore
  return h('table', h('tbody', table.rows.map(
      (row: stencila.TableRow): HTMLTableRowElement => {
        return h('tr', row.cells.map(
          (cell: stencila.TableCell): HTMLTableDataCellElement => {
            return h('td', cell.content.map(encodeNode))
          }
        ))
      }
    )
  ))
}

/**
 * Decode a HTML `<stencila-datatable>` element to a Stencila `Datatable` node.
 */
function decodeDatatable(elem: HTMLElement): stencila.Datatable {
  let columns: stencila.DatatableColumn[] = []
  const table = elem.querySelector('table')
  if (table) {
    const thead = table.querySelector('thead')
    if (thead) {
      columns = Array.from(thead.querySelectorAll('tr th')).map(
        (row, index): stencila.DatatableColumn => {
          const th = row.querySelector('th')
          const name = (th && th.innerText) || columnIndexToName(index)
          return {
            type: 'DatatableColumn',
            name,
            values: []
          }
        }
      )
    }

    const tbody = table.querySelector('tbody')
    if (tbody) {
      let rowi = 0
      for (const row of tbody.querySelectorAll('tr')) {
        let coli = 0
        for (const col of row.querySelectorAll('td')) {
          // TODO: Is further parsing e.g. to a number
          // required here?
          columns[coli].values[rowi] = col.innerHTML
          coli += 1
        }
        rowi += 1
      }
    }
  }

  return {
    type: 'Datatable',
    columns
  }
}

/**
 * Encode a Stencila `Datatable` node to a HTML `<stencila-datatable>` element.
 *
 * Note: currently this function is lossy for `DatatableColumn` properties
 * other than `name` and `value` (e.g. `schema`). These could be encoded into
 * the `<thead>`.
 */
function encodeDatatable(datatable: stencila.Datatable): HTMLElement {
  const cols = datatable.columns
  const rows = (cols[0] && cols[0].values.map((_, row) => row)) || []

  // prettier-ignore
  return h('stencila-datatable',
    h('table',
      h('thead',
        h('tr', cols.map(col => (
          h('th', col.name)
        )))
      ),
      h('tbody', rows.map((_, row) => (
        h('tr', cols.map(col => (
          h('td', col.values[row])
        )))
      )))
    )
  )
}

/**
 * Decode a `<hr>` element to a `stencila.ThematicBreak`.
 */
function decodeHR(hr: HTMLHRElement): stencila.ThematicBreak {
  return { type: 'ThematicBreak' }
}

/**
 * Encode a `stencila.ThematicBreak` to a `<hr>` element.
 */
function encodeThematicBreak(tb: stencila.ThematicBreak): HTMLHRElement {
  return h('hr')
}

/**
 * Decode an inline element e.g `<em>` to a `Mark` node e.g. `Emphasis`.
 */
function decodeMark<Type extends keyof typeof markTypes>(
  elem: HTMLElement,
  type: Type
): stencila.Mark {
  return { type, content: decodeInlineChildNodes(elem) }
}

/**
 * Encode a `Mark` node to an inline element e.g. `<em>`.
 */
function encodeMark(node: stencila.Mark, tag: string): HTMLElement {
  return h(tag, node.content.map(encodeNode))
}

/**
 * Decode a `<a>` element to a `stencila.Link`.
 */
function decodeLink(elem: HTMLAnchorElement): stencila.Link {
  const link: stencila.Link = {
    type: 'Link',
    target: elem.getAttribute('href') || '#',
    content: decodeInlineChildNodes(elem)
  }
  const meta = decodeDataAttrs(elem)
  if (meta) link.meta = meta
  return link
}

/**
 * Encode a `stencila.Link` to a `<a>` element.
 */
function encodeLink(link: stencila.Link): HTMLAnchorElement {
  const attrs = {
    href: link.target,
    ...encodeDataAttrs(link.meta || {})
  }
  return h('a', attrs, link.content.map(encodeNode))
}

/**
 * Decode a `<q>` element to a `stencila.Quote`.
 */
function decodeQuote(elem: HTMLQuoteElement): stencila.Quote {
  const quote: stencila.Quote = { type: 'Quote', content: [elem.innerHTML] }
  const cite = elem.getAttribute('cite')
  if (cite) quote.citation = cite
  return quote
}

/**
 * Encode a `stencila.Quote` to a `<q>` element.
 */
function encodeQuote(quote: stencila.Quote): HTMLQuoteElement {
  return h('q', { cite: quote.citation }, quote.content)
}

/**
 * Decode a `<code>` element to a `stencila.Code`.
 */
function decodeCode(elem: HTMLElement): stencila.Code {
  const code: stencila.Code = { type: 'Code', value: elem.textContent || '' }
  const clas = elem.getAttribute('class')
  if (clas) {
    const match = clas.match(/^language-(\w+)$/)
    if (match) {
      code.language = match[1]
    }
  }
  const meta = decodeDataAttrs(elem)
  if (meta) code.meta = meta
  return code
}

/**
 * Encode a `stencila.Code` to a `<code>` element.
 */
function encodeCode(
  code: stencila.Code,
  dataAttrs: boolean = true
): HTMLElement {
  return h('code', {
    class: code.language ? `language-${code.language}` : undefined,
    innerHTML: escape(code.value),
    ...(dataAttrs ? encodeDataAttrs(code.meta || {}) : {})
  })
}

/**
 * Decode a HTML `<img>` element to a Stencila `ImageObject`.
 */
function decodeImage(elem: HTMLImageElement): stencila.ImageObject {
  const image: stencila.ImageObject = {
    type: 'ImageObject',
    contentUrl: elem.src
  }
  if (elem.title) image.title = elem.title
  if (elem.alt) image.text = elem.alt
  return image
}

/**
 * Encode a Stencila `ImageObject` to a HTML `<img>` element.
 */
function encodeImageObject(image: stencila.ImageObject): HTMLImageElement {
  return h('img', {
    src: image.contentUrl,
    title: image.title,
    alt: image.text
  })
}

/**
 * Encode a Stencila `Math` node to a HTML `<math>` element.
 */
function encodeMath(math: any): HTMLElement {
  return h('math', { innerHTML: math.text })
}

/**
 * Decode a `<stencila-null>` element to a `null`.
 */
function decodeNull(elem: HTMLElement): null {
  return null
}

/**
 * Encode a `null` to a `<stencila-null>` element.
 */
function encodeNull(value: null): HTMLElement {
  return h('stencila-null', 'null')
}

/**
 * Decode a `<stencila-boolean>` element to a `boolean`.
 */
function decodeBoolean(elem: HTMLElement): boolean {
  return elem.innerHTML === 'true'
}

/**
 * Encode a `boolean` to a `<stencila-boolean>` element.
 */
function encodeBoolean(value: boolean): HTMLElement {
  return h('stencila-boolean', value === true ? 'true' : 'false')
}

/**
 * Decode a `<stencila-number>` element to a `number`.
 */
function decodeNumber(elem: HTMLElement): number {
  return parseFloat(elem.innerHTML || '0')
}

/**
 * Encode a `number` to a `<stencila-number>` element.
 */
function encodeNumber(value: number): HTMLElement {
  return h('stencila-number', value.toString())
}

/**
 * Decode a `<stencila-array>` element to a `array`.
 */
function decodeArray(elem: HTMLElement): any[] {
  return JSON5.parse(elem.innerHTML || '[]')
}

/**
 * Encode a `array` to a `<stencila-array>` element.
 */
function encodeArray(value: any[]): HTMLElement {
  return h('stencila-array', JSON5.stringify(value))
}

/**
 * Decode a `<stencila-object>` element to a `object`.
 */
function decodeObject(elem: HTMLElement): object {
  return JSON5.parse(elem.innerHTML || '{}')
}

/**
 * Encode a `object` to a `<stencila-object>` element.
 */
function encodeObject(value: object): HTMLElement {
  return h('stencila-object', JSON5.stringify(value))
}

/**
 * Decode a `<stencila-thing>` element to a `Thing`.
 */
function decodeThing(elem: HTMLElement): stencila.Thing {
  return JSON5.parse(elem.innerHTML || '{}')
}

/**
 * Encode a `Thing` to a `<stencila-thing>` element.
 */
function encodeThing(thing: stencila.Thing): HTMLElement {
  return h('stencila-thing', JSON5.stringify(thing))
}

/**
 * Decode a `#text` node to a `string`.
 */
function decodeText(text: Text): string {
  return text.data
}

/**
 * Encode a `string` to a `#text` node.
 */
function encodeString(value: string): Text {
  return document.createTextNode(escape(value))
}

/**
 * Decode the `data-` attributes of an element into a dictionary
 * of strings.
 */
function decodeDataAttrs(
  elem: HTMLElement
): { [key: string]: string } | undefined {
  const dict: { [key: string]: string } = {}
  Array.from(elem.attributes)
    .filter(attr => attr.name.startsWith('data-'))
    .forEach(attr => (dict[attr.name.slice(5)] = attr.value))
  return Object.keys(dict).length ? dict : undefined
}

/**
 * Encode a dictionary of strings to `data-` attributes to add to
 * an element (the inverse of `decodeDataAttrs`).
 */
function encodeDataAttrs(meta: { [key: string]: string }) {
  const attrs: { [key: string]: string } = {}
  for (const [key, value] of Object.entries(meta)) {
    attrs['data-' + key] = value
  }
  return attrs
}
