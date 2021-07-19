/**
 * [[include:src/codecs/jats/README.md]]
 *
 * @module codecs/jats
 */

/**
 * Hello contributor 👋! If you are working on this file, please
 * endeavor to remove the need for the following `eslint-disable` line 🙏.
 * Remove the line and run `npx eslint path/to/this/file.ts` to
 * see which code needs some linting ❤️.
 * See https://github.com/stencila/encoda/issues/199 for suggestions
 * on how to refactor code to avoid non-strict boolean expressions.
 */
/* eslint-disable @typescript-eslint/strict-boolean-expressions */

import { getLogger } from '@stencila/logga'
import stencila, { isA } from '@stencila/schema'
import crypto from 'crypto'
import { dropLeft, takeLeftWhile } from 'fp-ts/lib/Array'
import fs from 'fs-extra'
import { isDefined } from '../../util'
import { ensureArticle } from '../../util/content/ensureArticle'
import { ensureBlockContent } from '../../util/content/ensureBlockContent'
import { ensureBlockContentArray } from '../../util/content/ensureBlockContentArray'
import { ensureInlineContentArray } from '../../util/content/ensureInlineContentArray'
import { encodeIdentifierTypeUri } from '../../util/identifiers'
import { encodeCiteAuthorsYear } from '../../util/references'
import transform from '../../util/transform'
import * as vfile from '../../util/vfile'
/* eslint-disable import/no-duplicates */
import * as xml from '../../util/xml'
import {
  all,
  attr,
  Attributes,
  attrOrUndefined,
  child,
  children,
  elem,
  first,
  intOrUndefined,
  splitTextOrUndefined,
  text,
  textOrUndefined,
} from '../../util/xml'
import { MathMLCodec } from '../mathml'
import { Codec, CommonEncodeOptions } from '../types'

const log = getLogger('encoda:jats')
const mathml = new MathMLCodec()

type Content = stencila.InlineContent | stencila.BlockContent

/**
 * The DOCTYPE to use when encoding to JATS
 */
const DOCTYPE =
  'article PUBLIC "-//NLM//DTD JATS (Z39.96) Journal Archiving and Interchange DTD v1.1 20151215//EN" "JATS-archivearticle1.dtd"'

export class JatsCodec extends Codec implements Codec {
  /**
   * Media types that this codec will match.
   *
   * There is currently no registered
   * [media type](https://www.iana.org/assignments/media-types/media-types.xhtml)
   * for JATS.
   *
   * This custom type uses the [convention](https://en.wikipedia.org/wiki/XML_and_MIME)
   * of using `application/` and the `+xml` suffix to differentiate this format from other
   * XML-based formats.
   */
  public readonly mediaTypes = ['application/jats+xml']

  /**
   * File name extensions that this codec will match.
   */
  public readonly extNames = ['jats']

  /**
   * Sniff content to see if it is JATS XML.
   *
   * For speed, rather than parsing the entire content as XML, this
   * function just uses a regex to checks if the content contains a
   * JATS DOCTYPE declaration.
   * Obviously, it's possible that a file in some other format (e.g. Markdown)
   * could contain this string.
   *
   * @param content The content to be sniffed
   */
  public readonly sniff = async (content: string): Promise<boolean> => {
    if (await fs.pathExists(content)) {
      const stat = await fs.stat(content)
      if (stat.isFile()) content = await fs.readFile(content, 'utf8')
    }
    const regex = /<!DOCTYPE\s+article\s+PUBLIC\s+"|'-\/\/NLM\/\/DTD JATS \(Z39\.96\)/
    return regex.test(content)
  }

  /**
   * Decode a `VFile` with JATS content to a Stencila `Node`.
   *
   * @param file The `VFile` to decode
   * @returns A promise that resolves to a Stencila `Node`
   */
  public readonly decode = async (
    file: vfile.VFile
  ): Promise<stencila.Article | Content[]> => {
    const jats = await vfile.dump(file)
    const doc = xml.load(jats)
    return decodeDocument(doc)
  }

  /**
   * Encode a Stencila `Node` to a `VFile` with JATS content.
   *
   * @param thing The Stencila `Node` to encode
   * @returns A promise that resolves to a `VFile`
   */
  public readonly encode = async (
    node: stencila.Node,
    options: CommonEncodeOptions = this.commonEncodeDefaults
  ): Promise<vfile.VFile> => {
    const { isStandalone } = { ...this.commonEncodeDefaults, ...options }
    const doc = isStandalone
      ? {
          declaration: {
            attributes: {
              version: '1.0',
              encoding: 'utf-8',
            },
          },
          elements: [
            {
              type: 'doctype',
              doctype: DOCTYPE,
            },
            encodeArticle(
              (await encodePrepare(ensureArticle(node))) as stencila.Article
            ),
          ],
        }
      : {
          elements: encodeNode(await encodePrepare(node), initialEncodeState()),
        }
    const jats = xml.dump(doc, { spaces: 4 })
    return vfile.load(jats)
  }
}

// The following are the functions that do the actual decoding / encoding
// As far as possible, these are as decode/encode pairs next to each other
// e.g. `decodeFigure`, `encodeFigure`, to make it easier to obtain
// bidirectional consistency.

/**
 * Decode a JATS XML document to a Stencila `Node`.
 *
 * If there is no `<article>` element then returns an array of `Content` nodes.
 */
function decodeDocument(doc: xml.Element): stencila.Article | Content[] {
  const article = first(doc, 'article')
  if (article !== null) return decodeArticle(article)

  const { elements } = doc
  if (elements === undefined) {
    log.error('No elements in XML document')
    return []
  }

  return decodeElements(elements, initialDecodeState(doc)) as Content[]
}

/**
 * Do any async actions necessary on the node tree before encoding it.
 *
 * This avoids having to "taint" the whole decode function call stack with
 * async calls.
 */
async function encodePrepare(node: stencila.Node): Promise<stencila.Node> {
  return transform(node, async (node) => {
    if (stencila.isA('MathFragment', node) || stencila.isA('MathBlock', node)) {
      if (node.mathLanguage !== 'mathml' && node.mathLanguage !== 'tex') {
        const text = await mathml.dump(node)
        return {
          ...node,
          mathLanguage: 'mathml',
          text,
        }
      }
    }
    return node
  })
}

/**
 * It is necessary to maintain some state during decoding.
 * This interface defines that state; an instance
 * is passed down through decoding functions.
 *
 * An alternative approach would be to make the functions
 * methods of a class (e.g. the `JatsCodec` class).
 */
interface DecodeState {
  /**
   * The current `<article>` element. Used for
   * getting the target of internal references.
   */
  article: xml.Element

  /**
   * The closest ancestor element. It is up to
   * decode functions to set this, therefore not
   * necessarily the parent
   */
  ancestorElem: xml.Element

  /**
   * The id of the current section. Used for setting the
   * id of headings.
   */
  sectionId: string

  /**
   * The depth of the current section. Used for setting the depth
   * of headings.
   */
  sectionDepth: number
}

const initialDecodeState = (article: xml.Element): DecodeState => ({
  article,
  ancestorElem: article,
  sectionId: '',
  sectionDepth: 0,
})

/**
 * It is necessary to maintain some state during encoding.
 * This interface defines that state; an instance
 * is passed down through encoding functions.
 *
 * An alternative approach would be to make the functions
 * methods of a class (e.g. the `JatsCodec` class).
 */
interface EncodeState {
  /**
   * The current number of tables in the article.
   * Used for labelling tables.
   */
  tables: number

  /**
   * Citation elements that we have generated that need some content added to
   * them for rendering, as we can encounter citations before references.
   *
   * {bib1: elem('xref', ...)}
   */
  citations: { [rid: string]: xml.Element[] }

  /**
   * A lookup of reference ID to how they are rendered inside a citation, e.g:
   * {bib1: "Author [et al] (Year)"}
   *
   * These might be encountered before a citation that uses them, so both are
   * stored.
   */
  references: { [rid: string]: string }
}

const initialEncodeState = (): EncodeState => ({
  tables: 0,
  citations: {},
  references: {},
})

/**
 * Decode an XML element if it is defined.
 */
function decodeMaybe<Type extends stencila.Node>(
  elem: xml.Element | null | undefined,
  func: (defined: xml.Element) => Type | undefined
): Type | undefined {
  return isDefined(elem) ? func(elem) : undefined
}

/**
 * Decode a JATS `<article>` element to a Stencila `Article`.
 *
 * Extracts front- and back-matter, from `<front>` and
 * `<back>` respectively and decodes `<body>` to `content`.
 */
function decodeArticle(article: xml.Element): stencila.Article {
  const state: DecodeState = initialDecodeState(article)

  const { meta: metaFront, ...front } = decodeFront(
    child(article, 'front'),
    state
  )
  const { meta: metaBack, ...back } = decodeBack(child(article, 'back'))
  const metaAll = { ...metaFront, ...metaBack }
  const meta = Object.keys(metaAll).length > 0 ? metaAll : undefined

  const content = decodeBody(child(article, 'body'), state)

  return stencila.article({ ...front, ...back, meta, content })
}

/**
 * Encode a Stencila `Article` as a JATS `<article>`.
 */
function encodeArticle(article: stencila.Article): xml.Element {
  const {
    title = '',
    authors = [],
    description,
    content = [],
    references,
  } = article

  const front = elem(
    'front',
    elem(
      'article-meta',
      encodeTitle(title),
      encodeAuthors(authors),
      encodeAbstract(description)
    )
  )

  const state: EncodeState = initialEncodeState()
  const body = encodeBody(content, state)

  const back = elem('back', ...encodeReferences(references, state))

  return elem(
    'article',
    {
      'xmlns:xlink': 'http://www.w3.org/1999/xlink',
      'article-type': 'research-article',
    },
    front,
    body,
    back
  )
}

// Front-matter related functions

/**
 * Decode a JATS `<front>` element to properties of a Stencila `Article`.
 */
function decodeFront(
  front: xml.Element | null,
  state: DecodeState
): Pick<
  stencila.Article,
  | 'authors'
  | 'editors'
  | 'datePublished'
  | 'title'
  | 'description'
  | 'isPartOf'
  | 'licenses'
  | 'keywords'
  | 'identifiers'
  | 'fundedBy'
  | 'meta'
  | 'pageEnd'
  | 'pageStart'
  | 'about'
  | 'genre'
> {
  const subjGroups = all(front, 'subj-group')
  return front === null
    ? {}
    : {
        authors: decodeAuthors(front, state),
        editors: decodeEditors(front, state),
        datePublished: decodeDatePublished(front),
        ...decodeHistory(front),
        title: decodeTitle(first(front, 'article-title'), state),
        description: decodeAbstract(first(front, 'abstract'), state),
        isPartOf: decodeIsPartOf(front),
        licenses: decodeLicenses(front, state),
        keywords: decodeKeywords(front, subjGroups),
        identifiers: decodeIdentifiers(front),
        fundedBy: decodeFunding(front),
        meta: decodeMetaFront(front),
        pageStart: decodePageStart(front),
        pageEnd: decodePageEnd(front),
        about: decodeAbout(subjGroups),
        genre: decodeGenres(subjGroups),
      }
}

/**
 * Returns the element if not empty ( "" as string )
 * undefined if not.
 */
const emptySafeString = (str: string | undefined): string | undefined =>
  str?.length ? str : undefined

/**
 * Decode a JATS `<subj-group>` if attribute 'subj-group-type' includes
 * about types elements to a Stencila `Article.about`.
 */
function decodeAbout(subjectGroups: xml.Element[]): stencila.Article['about'] {
  const ABOUT_TYPES = [
    'subject',
    'discipline',
    'section',
    'primary/secondary',
    'system taxonomy',
    'taxonomy',
    'heading',
  ]
  const about = subjectGroups
    .map((elem) => {
      const type = attr(elem, 'subj-group-type') ?? ''
      const subject = child(elem, ['subject'])
      const name = emptySafeString(
        textOrUndefined(xml.firstByType(subject, 'text'))
      )
      return name && ABOUT_TYPES.includes(type)
        ? stencila.definedTerm({ name })
        : undefined
    })
    .filter(isDefined)
  return about.length ? about : undefined
}

/**
 * Decode a JATS `<subj-group>` if attribute 'subj-group-type' includes
 * genre types elements to a Stencila `Article.genre`.
 */
function decodeGenres(subjectGroups: xml.Element[]): stencila.Article['genre'] {
  const GENRES_TYPES = ['display-channel', 'Toc-heading', 'toc', 'banner']
  const genres = subjectGroups
    .map((elem) => {
      const type = attr(elem, 'subj-group-type') ?? ''
      const subject = child(elem, ['subject'])
      const value = emptySafeString(
        textOrUndefined(xml.firstByType(subject, 'text'))
      )
      return GENRES_TYPES.includes(type) ? value : undefined
    })
    .filter(isDefined)
  return genres.length ? genres : undefined
}

/**
 * Decode a JATS `<article-title>` element to a Stencila `Article.title`.
 */
function decodeTitle(
  title: xml.Element | null,
  state: DecodeState
): stencila.Article['title'] {
  if (title === null || title.elements === undefined) return 'Untitled'
  if (title.elements.length === 1 && title.elements[0].type === 'text')
    return text(title)
  else return decodeInlineContent(title.elements, state)
}

/**
 * Encode a Stencila `Article.title` to a JATS `<article-group>`
 * with a nested `<article-title>` element.
 */
function encodeTitle(title: stencila.Article['title']): xml.Element {
  const articleTitle =
    typeof title === 'string'
      ? elem('article-title', title)
      : elem(
          'article-title',
          ...encodeNodes(title ?? 'Untitled', initialEncodeState())
        )
  return elem('title-group', articleTitle)
}

/**
 * Decode a JATS `<fpage>` element to a Stencila `Article.pageStart`.
 */
function decodePageStart(
  front: xml.Element | null
): stencila.Article['pageStart'] {
  const pageStart = first(front, 'fpage')

  if (pageStart === null || pageStart.elements === undefined) return
  if (pageStart.elements.length === 1 && pageStart.elements[0].type === 'text')
    return text(pageStart)
}

/**
 * Decode a JATS `<lpage>` element to a Stencila `Article.pageEnd`.
 */
function decodePageEnd(front: xml.Element | null): stencila.Article['pageEnd'] {
  const pageEnd = first(front, 'lpage')

  if (pageEnd === null || pageEnd.elements === undefined) return
  if (pageEnd.elements.length === 1 && pageEnd.elements[0].type === 'text')
    return text(pageEnd)
}

/**
 * Decode a JATS `<abstract>` element to a Stencila `Article.description`.
 */
function decodeAbstract(
  elem: xml.Element | null,
  state: DecodeState
): stencila.Article['description'] {
  if (elem === null) return undefined
  const ps = children(elem, 'p')
  if (ps.length === 0) return undefined
  if (ps.length === 1) {
    const content = decodeInlineContent(ps, state)
    return content.length === 1 && typeof content[0] === 'string'
      ? content[0]
      : content
  }
  return ensureBlockContentArray(decodeElements(ps, state))
}

/**
 * Encode a Stencila `Article.description` to a JATS `<abstract>` element.
 */
export function encodeAbstract(
  description?: stencila.Article['description']
): xml.Element | null {
  if (description === undefined) return null
  const paras =
    typeof description === 'string'
      ? elem('p', description)
      : elem('p', ...encodeNodes(description, initialEncodeState()))
  return elem('abstract', paras)
}

/**
 * Decode JATS `<pub-date>` elements into a Stencila `Article.datePublished` property.
 *
 * Will return the first date with `date-type==publication` or `pub-type==epub`, or
 * the first date if none of those exist.
 */
function decodeDatePublished(
  front: xml.Element
): stencila.Article['datePublished'] {
  const dates = all(front, 'pub-date')
  if (dates.length === 0) return undefined
  for (const date of dates) {
    if (
      attr(date, 'date-type') === 'publication' ||
      attr(date, 'pub-type') === 'epub'
    ) {
      return decodeDate(date)
    }
  }
  return decodeDate(dates[0])
}

/**
 * Decode a JATS `<date>` or `<pub-date>` element into a Stencila `Date`
 */
function decodeDate(date: xml.Element): stencila.Date | undefined {
  let value
  const iso = attr(date, 'iso-8601-date')
  if (iso !== null) value = iso
  else {
    const year = text(child(date, 'year'))
    if (year === null) return undefined
    value = `${year.padStart(4, '0')}`

    const month = text(child(date, 'month'))
    if (month !== null) value += `-${month.padStart(2, '0')}`

    const day = text(child(date, 'day'))
    if (day !== null) value += `-${day.padStart(2, '0')}`
  }
  return stencila.date({ value })
}

/**
 * Decode various JATS `<front>` elements (e.g. `<journal-meta>`, `<volume>`)
 * into a Stencila `Article.isPartOf` property.
 */
function decodeIsPartOf(front: xml.Element): stencila.Article['isPartOf'] {
  const journal = first(front, 'journal-meta')
  if (journal === null) return undefined

  const title = textOrUndefined(first(journal, 'journal-title'))
  const issns = all(journal, 'issn').map(textOrUndefined).filter(isDefined)
  const identifiers = all(journal, 'journal-id')
    .map((elem) => {
      const name = attr(elem, 'journal-id-type') ?? undefined
      const propertyID = encodeIdentifierTypeUri(name)
      const value = textOrUndefined(elem)
      return value !== undefined
        ? stencila.propertyValue({ name, propertyID, value })
        : undefined
    })
    .filter(isDefined)
  const publisher = textOrUndefined(first(journal, 'publisher-name'))
  const volumeNumber = textOrUndefined(first(front, 'volume'))
  const issueNumber = textOrUndefined(first(front, 'issue'))

  let isPartOf: stencila.CreativeWork | undefined
  if (title !== undefined && issns !== undefined && identifiers !== undefined)
    isPartOf = stencila.periodical({
      title,
      issns,
      identifiers,
      publisher:
        publisher !== undefined
          ? stencila.organization({ name: publisher })
          : undefined,
    })
  if (volumeNumber !== undefined)
    isPartOf = stencila.publicationVolume({ volumeNumber, isPartOf })
  if (issueNumber !== undefined)
    isPartOf = stencila.publicationIssue({ issueNumber, isPartOf })

  return isPartOf
}

/**
 * Decode a JATS `<permissions>` elements into a Stencila `licenses` property,
 * e.g. in the Article frontmatter or for a figure or media object.
 */
function decodeLicenses(
  elem: xml.Element,
  state: DecodeState
): stencila.Article['licenses'] {
  const permissions = first(elem, 'permissions')
  const licenses = all(permissions, 'license')
  if (licenses.length === 0) return undefined

  return licenses.reduce((prev: stencila.CreativeWork[], license) => {
    const url = attrOrUndefined(license, 'xlink:href')
    const p = first(license, 'license-p')
    const content = p !== null ? decodeParagraph(p, state) : undefined
    return [...prev, stencila.creativeWork({ url, content })]
  }, [])
}

/**
 * Decode JATS `<kwd>` and `<subj-group>` if attribute 'subj-group-type' includes
 * elements of keywords types to a Stencila `Article.keywords`.
 */
function decodeKeywords(
  front: xml.Element,
  subjectGroups: xml.Element[]
): stencila.Article['keywords'] {
  const kwds = all(front, 'kwd')
  const kwdsArray = kwds
    .map((elem: xml.Element) => textOrUndefined(elem))
    .filter(isDefined)
  const kwdsTypes = subjectGroups
    .map((elem: xml.Element) => {
      const type = attr(elem, 'subj-group-type') ?? ''
      const KEYWORDS_TYPES = ['keywords', 'kwd']
      const subject = child(elem, ['subject'])
      const value = emptySafeString(
        textOrUndefined(xml.firstByType(subject, 'text'))
      )
      return KEYWORDS_TYPES.includes(type) ? value : undefined
    })
    .filter(isDefined)
  const result = [...kwdsArray, ...kwdsTypes]
  return result.length ? result : undefined
}

/**
 * Decode JATS `<article-id>` and `<elocation-id>` elements into
 * a Stencila `Article.identifiers` property.
 */
function decodeIdentifiers(
  front: xml.Element
): stencila.Article['identifiers'] {
  return [
    ...all(front, 'article-id').map((elem) => {
      const name = attr(elem, 'pub-id-type') ?? undefined
      const propertyID = encodeIdentifierTypeUri(name)
      const value = textOrUndefined(elem)
      return value !== undefined
        ? stencila.propertyValue({
            name,
            propertyID,
            value,
          })
        : undefined
    }),
    ...all(front, 'elocation-id').map((elem) => {
      const name = 'elocation-id'
      const propertyID = encodeIdentifierTypeUri(name)
      const value = textOrUndefined(elem)
      return value !== undefined
        ? stencila.propertyValue({
            name,
            propertyID,
            value,
          })
        : undefined
    }),
  ].filter(isDefined)
}

/**
 * Decode JATS `<funding-group>` element into a Stencila `Article.fundedBy` property.
 */
function decodeFunding(front: xml.Element): stencila.Article['fundedBy'] {
  const funding = first(front, 'funding-group')
  const awards = all(funding, 'award-group')
  if (awards.length === 0) return undefined

  return awards.map((award) => {
    const identifiers = all(award, 'award-id')
      .map((id) => {
        const value = textOrUndefined(id)
        return value !== undefined
          ? stencila.propertyValue({ value })
          : undefined
      })
      .filter(isDefined)

    const funders = all(award, 'funding-source').reduce(
      (orgs: stencila.Organization[], org) => {
        // Prefer <institution>, but fallback to just text content
        let name = textOrUndefined(first(org, 'institution'))
        if (name === undefined) name = textOrUndefined(org)
        if (name === undefined) return orgs
        // Avoid duplicates
        for (const org of orgs) {
          if (org.name === name) return orgs
        }
        return [...orgs, stencila.organization({ name })]
      },
      []
    )

    return stencila.monetaryGrant({
      identifiers,
      funders,
    })
  })
}

/**
 * Decode dates from the `<history>` of a JATS article into an `Article.date*` properties.
 */
function decodeHistory(
  front: xml.Element
): Pick<stencila.Article, 'dateReceived' | 'dateAccepted'> {
  const history = first(front, 'history')
  return {
    dateReceived: decodeMaybe<stencila.Date>(
      child(history, 'date', { 'date-type': 'received' }),
      decodeDate
    ),
    dateAccepted: decodeMaybe<stencila.Date>(
      child(history, 'date', { 'date-type': 'accepted' }),
      decodeDate
    ),
  }
}

/**
 * Decode elements from the `<front>` of a JATS article into an `Article.meta` property.
 */
function decodeMetaFront(front: xml.Element): stencila.Article['meta'] {
  // Simply extract all footnotes withing the <author-notes> element as plain text
  const authorNotes = all(first(front, 'author-notes'), 'fn')
    .map(textOrUndefined)
    .filter(isDefined)

  return {
    authorNotes: authorNotes.length > 0 ? authorNotes : undefined,
  }
}

/**
 * Decode JATS `<contrib contrib-type = "author">` elements
 * to a Stencila `Article.authors` property.
 */
function decodeAuthors(
  front: xml.Element,
  state: DecodeState
): stencila.Article['authors'] {
  const contribGroup = first(front, 'contrib-group')
  const authors = children(contribGroup, 'contrib', {
    'contrib-type': 'author',
  })
  return authors.length > 0
    ? authors.map((author) => decodeContrib(author, state))
    : undefined
}

/**
 * Encode a Stencila `Article.authors` property into a JATS
 * `<contrib-group>` element.
 */
function encodeAuthors(authors: stencila.Article['authors']): xml.Element {
  const init: { auths: xml.Element[]; affs: xml.Element[] } = {
    auths: [],
    affs: [],
  }
  const { auths, affs } =
    authors?.map(encodeAuthor).reduce(
      (prev, curr) => ({
        auths: [...prev.auths, curr.auth],
        affs: [...prev.affs, ...curr.affs],
      }),
      init
    ) ?? init
  return elem('contrib-group', ...auths, ...affs)
}

/**
 * Decode JATS `<contrib contrib-type = "editors">` elements
 * to a Stencila `Article.editors` property.
 */
function decodeEditors(
  front: xml.Element,
  state: DecodeState
): stencila.Article['editors'] {
  const editors = all(front, 'contrib', { 'contrib-type': 'editor' })
  return editors.length > 0
    ? editors.reduce((allEditors: stencila.Person[], editor) => {
        const author = decodeContrib(editor, state)
        return isA('Person', author) ? [...allEditors, author] : allEditors
      }, [])
    : undefined
}

/**
 * Decode a JATS `<contrib>` element to a `Person` or `Organization` node.
 *
 * It is necessary to pass the `<article>` element to this function
 * (via `state`) so that author affiliations can be extracted.
 */
function decodeContrib(
  contrib: xml.Element,
  state: DecodeState
): stencila.Person | stencila.Organization {
  const collab = child(contrib, 'collab')
  if (collab) {
    // Create an Organization contributor with individuals as
    // its `members` each with their own affiliations. If there
    // are multiple emails, these are assumed to be for multiple
    // contact points rather than multiple emails for a single
    // contact.
    const emails = children(contrib, 'email')
    const subContribs = all(contrib, 'contrib')
    return stencila.organization({
      name: text(xml.firstByType(collab, 'text')),
      contactPoints: emails.length
        ? emails.map((email) =>
            stencila.contactPoint({ emails: [text(email)] })
          )
        : undefined,
      members: subContribs.length
        ? subContribs.map((subContrib) => decodeContrib(subContrib, state))
        : undefined,
    })
  } else {
    // Create a Person contributor with organizational affiliations
    const name = child(contrib, ['name', 'string-name'])
    const contributor = name ? decodeName(name) : stencila.person()

    const emails = all(contrib, 'email')
    if (emails.length) contributor.emails = emails.map(text)

    let affiliations: stencila.Organization[] = []

    const affs = all(contrib, 'aff')
    if (affs.length > 0) {
      affiliations = [...affiliations, ...affs.map(decodeAff)]
    }

    const affRefs = all(contrib, 'xref', { 'ref-type': 'aff' })
    if (affRefs.length > 0) {
      affiliations = [
        ...affiliations,
        ...affRefs
          .map((ref) => {
            const id = ref.attributes?.rid
            const aff = first(state.article, 'aff', { id: id })
            if (!aff) {
              log.warn(`Could not find <aff id=${id}>`)
              return null
            }
            return decodeAff(aff)
          })
          .reduce(
            (prev: stencila.Organization[], curr) =>
              curr ? [...prev, curr] : prev,
            []
          ),
      ]
    }

    if (affiliations.length) contributor.affiliations = affiliations

    return contributor
  }
}

/**
 * Encode a Stencila `Person` or `Organisation` (the valid
 * node types of the `Article.authors` property) into
 * a JATS `<contrib contrib-type = "author">` element.
 */
function encodeAuthor(
  author: stencila.Person | stencila.Organization
): {
  auth: xml.Element
  affs: xml.Element[]
} {
  let name: xml.Element
  let affs: xml.Element[] = []
  if (author.type === 'Person') {
    name = encodeName(author)
    if (author.affiliations) {
      affs = author.affiliations.map((org) =>
        elem(
          'aff',
          { id: crypto.randomBytes(16).toString('hex') },
          elem('institution', org.name ?? '')
        )
      )
    }
  } else {
    name = elem('string-name', author.legalName ?? author.name ?? '')
  }

  const affRefs = affs.map((aff) =>
    elem('xref', {
      'ref-type': 'aff',
      rid: aff.attributes?.id,
    })
  )
  const auth = elem('contrib', { 'contrib-type': 'author' }, name, ...affRefs)

  return { auth, affs }
}

/**
 * Decode a JATS `<name>` element into a Stencila `Person` node.
 */
function decodeName(name: xml.Element): stencila.Person {
  return stencila.person({
    givenNames: splitTextOrUndefined(child(name, 'given-names'), /\s+/),
    familyNames: splitTextOrUndefined(child(name, 'surname'), /\s+/),
    honorificPrefix: textOrUndefined(child(name, 'prefix')),
    honorificSuffix: textOrUndefined(child(name, 'suffix')),
  })
}

/**
 * Encode a Stencila `Person` node into a JATS `<name>` element
 * or `<string-name>` element.
 */
function encodeName(person: stencila.Person): xml.Element {
  if (person.familyNames || person.givenNames) {
    return elem(
      'name',
      person.familyNames ? elem('surname', person.familyNames.join(' ')) : null,
      person.givenNames
        ? elem('given-names', person.givenNames.join(' '))
        : null,
      person.honorificPrefix ? elem('prefix', person.honorificPrefix) : null,
      person.honorificSuffix ? elem('suffix', person.honorificSuffix) : null
    )
  } else {
    return elem('string-name', person.name ?? '')
  }
}

/**
 * Decode a JATS `<aff>` element into a Stencila `Organization` node.
 *
 * Uses the first `<institution>` element as the name of the organization.
 * Sometimes there is no `<institution>` element and `<addr-line>` is
 * used for name and address combined. So this uses the first address components
 * as the name if necessary.
 *
 * When there are multiple `<institution>` elements this decodes them
 * assuming that they are ordered hierarchically i.e. that the first
 * is a part of the second etc. See https://github.com/stencila/encoda/issues/458
 */
function decodeAff(aff: xml.Element): stencila.Organization {
  const institutions = children(aff, 'institution')
  let addressComponents = all(aff, [
    'addr-line',
    'city',
    'state',
    'country',
    'postal-code',
  ])
  const url = textOrUndefined(child(aff, 'uri'))

  let name = textOrUndefined(institutions[0] ?? null)
  if (name === undefined && addressComponents.length > 0) {
    const [first, ...rest] = addressComponents
    name = text(first)
    addressComponents = rest
  }

  const parentOrganization =
    institutions.length <= 1
      ? undefined
      : institutions.slice(1).reduce((prev, curr) => {
          const parent = stencila.organization({ name: textOrUndefined(curr) })
          prev.parentOrganization = parent
          return parent
        }, stencila.organization({ name: textOrUndefined(institutions[1]) }))

  const addressProperties = addressComponents.reduce((prev, curr) => {
    const mapping: Record<string, string> = {
      'addr-line': 'streetAddress',
      city: 'addressLocality',
      state: 'addressRegion',
      country: 'addressCountry',
      'postal-code': 'postalCode',
    }
    const property = mapping[curr.name ?? '']
    return { ...prev, [property]: textOrUndefined(curr) }
  }, {} as Record<string, string | undefined>)

  const { streetAddress, addressLocality } = addressProperties
  if (streetAddress !== undefined && addressLocality === undefined) {
    addressProperties.streetAddress = undefined
    addressProperties.addressLocality = streetAddress
  }

  const address =
    Object.values(addressProperties).filter(isDefined).length > 0
      ? stencila.postalAddress(addressProperties)
      : undefined

  return stencila.organization({
    name,
    parentOrganization,
    url,
    address,
  })
}

// Back-matter related functions

/**
 * Decode a JATS `<back>` element into properties of a Stencila `Article`
 */
function decodeBack(
  back: xml.Element | null
): Pick<stencila.Article, 'references' | 'meta'> {
  if (back === null) return {}
  const references = decodeReferences(first(back, 'ref-list'))
  return { references }
}

/**
 * Decode a JATS `<ref-list>` element to a Stencila `Article.reference`
 * property.
 */
function decodeReferences(
  elem: xml.Element | null
): stencila.Article['references'] {
  if (elem === null) return undefined

  return all(elem, 'ref').reduce((prev: stencila.CreativeWork[], ref) => {
    const citation = child(ref, ['element-citation', 'mixed-citation'])
    return citation
      ? [...prev, decodeReference(citation, attr(ref, 'id'))]
      : prev
  }, [])
}

/**
 * Encode a Stencila `Article.references` property to a
 * JATS `<ref-list>` element.
 *
 * @returns A array with a single `<ref-list>` element
 * if the article has references, otherwise an empty array.
 */
function encodeReferences(
  references: stencila.Article['references'],
  state: EncodeState
): xml.Element[] {
  return references === undefined
    ? []
    : [
        elem(
          'ref-list',
          elem('title', 'References'),
          ...references.map((ref) => encodeReference(ref, state))
        ),
      ]
}

/**
 * Decode a JATS `<element-citation>` or `<mixed-citation>` element
 * into a `CreativeWork` node.
 */
function decodeReference(
  elem: xml.Element,
  ident: string | null
): stencila.CreativeWork {
  const publicationType = attr(elem, 'publication-type')
  const id = decodeInternalId(ident)

  let authors: stencila.CreativeWork['authors'] = all(elem, [
    'name',
    'collab',
  ]).map((authorElem) => {
    if (authorElem.name === 'name') return decodeName(authorElem)
    else return stencila.organization({ name: textOrUndefined(authorElem) })
  })
  // If no authors identified using `<name>` elements
  // then use the text of `<person-group>`
  if (authors.length === 0) {
    const name = textOrUndefined(child(elem, 'person-group'))
    if (name !== undefined) authors = [stencila.organization({ name })]
  }

  // The year can sometimes include a suffix e.g. 2012a (if there are multiple references
  // for the same author in a year). So this removes that suffix by only ever taking the
  // first four digits
  const datePublishedString = textOrUndefined(child(elem, 'year'))
  let datePublished: stencila.Date | undefined
  if (datePublishedString !== undefined) {
    const match = /^(\d{4})/.exec(datePublishedString)
    if (match) datePublished = stencila.date({ value: match[1] })
  }

  let title: string | undefined
  let isPartOf: stencila.CreativeWork | undefined
  if (publicationType === 'journal' || publicationType === 'preprint') {
    title = textOrUndefined(child(elem, 'article-title'))

    const periodicalName = textOrUndefined(child(elem, 'source'))
    const volumeNumber = intOrUndefined(child(elem, 'volume'))
    const issueNumber = intOrUndefined(child(elem, 'issue'))
    if (periodicalName !== undefined)
      isPartOf = stencila.periodical({ name: periodicalName })
    if (volumeNumber !== undefined)
      isPartOf = stencila.publicationVolume({ volumeNumber, isPartOf })
    if (issueNumber !== undefined)
      isPartOf = stencila.publicationIssue({ issueNumber, isPartOf })
  } else if (publicationType === 'book' || publicationType === 'report') {
    title = textOrUndefined(child(elem, 'chapter-title'))
    if (title !== undefined) {
      // Book or report chapter so try to create a `isPartOf` property
      const book = textOrUndefined(child(elem, 'source'))
      if (book !== undefined) {
        isPartOf = stencila.creativeWork({ name: book })
      }
    } else {
      // Not a chapter so title is <source>
      title = textOrUndefined(child(elem, 'source'))
    }
  } else {
    // e.g. publicationType: 'software', 'web', 'patent'
    title = textOrUndefined(
      child(elem, ['article-title', 'chapter-title', 'data-title'])
    )
  }

  // If title is still undefined and elem is a <mixed-citation> then use
  // its text content e.g.
  //    <mixed-citation publication-type="other" xlink:type="simple">Maynard Smith J (1982) Evolution and the Theory of Games. Cambridge University Press.</mixed-citation>
  if (title === undefined && elem.name === 'mixed-citation') {
    title = textOrUndefined(elem)
  }

  const pageStart = intOrUndefined(child(elem, 'fpage'))
  const pageEnd = intOrUndefined(child(elem, 'lpage'))
  const url = attrOrUndefined(child(elem, 'ext-link'), 'xlink:href')

  let publisher: stencila.Organization | undefined
  const publisherName = textOrUndefined(child(elem, 'publisher-name'))
  if (publisherName !== undefined) {
    let address: stencila.PostalAddress | undefined
    const location = textOrUndefined(child(elem, 'publisher-loc'))
    if (location !== undefined) {
      address = stencila.postalAddress({ addressLocality: location })
    }
    publisher = stencila.organization({ name: publisherName, address })
  }

  let identifiers: stencila.CreativeWork['identifiers'] = all(elem, 'pub-id')
    .map((elem) => {
      const name = attr(elem, 'pub-id-type') ?? undefined
      const propertyID = encodeIdentifierTypeUri(name)
      const value = textOrUndefined(elem)
      return value !== undefined
        ? stencila.propertyValue({
            name,
            propertyID,
            value,
          })
        : undefined
    })
    .filter(isDefined)
  if (identifiers.length === 0) identifiers = undefined

  return stencila.article({
    id,
    authors,
    title,
    datePublished,
    pageStart,
    pageEnd,
    isPartOf,
    publisher,
    identifiers,
    url,
  })
}

/**
 * Encode a Stencila `Article.references` item as a JATS `<ref>`
 * element,
 */
function encodeReference(
  work: stencila.CreativeWork | string,
  state: EncodeState
): xml.Element {
  let rid
  if (typeof work === 'string') {
    return elem('ref')
  } else {
    rid = work.id
    const children = []

    const { title, authors, datePublished, isPartOf } = work

    if (title) children.push(elem('article-title', ...encodeNodes(title)))

    if (authors?.length) {
      const people = authors.filter(stencila.isType('Person')).map(encodeName)

      const personGroup = elem(
        'person-group',
        { 'person-group-type': 'author' },
        ...people
      )

      if (rid && state.references[rid] === undefined) {
        state.references[rid] = encodeCiteAuthorsYear(work)
        populateBibrContent(rid, state)
      }

      children.push(personGroup)
    }

    if (datePublished) {
      const dateString =
        typeof datePublished === 'string' ? datePublished : datePublished.value
      children.push(
        elem(
          'year',
          {
            'iso-8601-date': dateString,
          },
          dateString
        )
      )
    }

    if (stencila.isA('Article', work)) {
      const { pageStart, pageEnd } = work
      if (pageStart !== undefined) children.push(elem('fpage', `${pageStart}`))
      if (pageEnd !== undefined) children.push(elem('lpage', `${pageEnd}`))
    }

    let parent = isPartOf
    do {
      if (stencila.isA('PublicationIssue', parent)) {
        const { issueNumber } = parent
        if (issueNumber !== undefined)
          children.push(elem('issue', `${issueNumber}`))
      }
      if (stencila.isA('PublicationVolume', parent)) {
        const { volumeNumber } = parent
        if (volumeNumber !== undefined)
          children.push(elem('volume', `${volumeNumber}`))
      }
      if (stencila.isA('Periodical', parent)) {
        const { name } = parent
        if (name !== undefined) children.push(elem('source', name))
      }
    } while ((parent = parent?.isPartOf) !== undefined)

    return elem('ref', { id: rid }, elem('element-citation', null, ...children))
  }
}

// Functions for decoding / encoding content in article body
// These functions generally return an array of nodes or elements,
// usually only containing one or zero item. This provides some
// convenience by being able to de-structure the returned array
// instead of having to check for undefined.

/**
 * Decode the JATS `<body>` element to an array of Stencila `Node`s
 */
function decodeBody(
  body: xml.Element | null,
  state: DecodeState
): stencila.Article['content'] {
  return body === null
    ? undefined
    : ensureBlockContentArray(decodeDefault(body, state))
}

/**
 * Encode an array of Stencila `Node`s to a JATS `<body>` element
 */
function encodeBody(nodes: stencila.Node[], state: EncodeState): xml.Element {
  const sections: xml.Element[] = []
  let section: xml.Element | undefined
  for (const node of nodes) {
    if (stencila.nodeType(node) === 'Heading') {
      section = elem('sec')
      sections.push(section)
    }
    const el = encodeNode(node, state)
    if (!section) {
      section = elem('sec')
      sections.push(section)
    }
    if (section.elements) section.elements.push(...el)
  }
  return elem('body', ...sections)
}

/**
 * Decode a JATS element to an array of Stencila `Node`s
 */
function decodeElement(elem: xml.Element, state: DecodeState): stencila.Node[] {
  if (elem.type === 'text') return [elem.text ?? '']
  switch (elem.name) {
    case 'alternatives':
      return decodeAlternatives(elem, state)
    case 'sec':
      return decodeSection(elem, state)
    case 'title':
      return decodeHeading(elem, state)
    case 'p':
      return decodeParagraph(elem, state)
    case 'list':
      return decodeList(elem, state)
    case 'table-wrap':
      return decodeTableWrap(elem, state)
    case 'ext-link':
      return decodeExtLink(elem, state)
    case 'inline-graphic':
      return decodeGraphic(elem, true)
    case 'graphic':
      return decodeGraphic(elem, false)
    case 'media':
      return decodeMedia(elem)
    case 'xref':
      return decodeXRef(elem, state)
    case 'italic':
      return decodeMark(elem, state, 'Emphasis')
    case 'bold':
      return decodeMark(elem, state, 'Strong')
    case 'sup':
      return decodeMark(elem, state, 'Superscript')
    case 'sub':
      return decodeMark(elem, state, 'Subscript')
    case 'inline-formula':
    case 'disp-formula':
      return decodeMath(elem)
    case 'break':
      return decodeBreak()
    case 'fig':
      return decodeFigure(elem, state)
    case 'fig-group':
      return decodeFigGroup(elem, state)
    case 'supplementary-material':
      return decodeSupplementaryMaterial(elem, state)
    case 'code':
      return decodeCode(elem)
    case 'fn':
      return decodeNote(elem, state)
    case 'statement':
      return decodeStatement(elem, state)
    default:
      log.warn(`Using default decoding for JATS element name: "${elem.name}"`)
      return decodeDefault(elem, state)
  }
}

/**
 * Encode a Stencila `Node` as an array of JATS elements
 */
function encodeNode(node: stencila.Node, state: EncodeState): xml.Element[] {
  switch (stencila.nodeType(node)) {
    case 'Article':
      return [encodeArticle(node as stencila.Article)]

    case 'Heading':
      return encodeHeading(node as stencila.Heading, state)
    case 'Paragraph':
      return encodeParagraph(node as stencila.Paragraph, state)
    case 'List':
      return encodeList(node as stencila.List, state)
    case 'Table':
      return encodeTable(node as stencila.Table, state)
    case 'Link':
      return encodeLink(node as stencila.Link, state)
    case 'Emphasis':
      return encodeMark(node as stencila.Emphasis, state, 'italic')
    case 'Strong':
      return encodeMark(node as stencila.Strong, state, 'bold')
    case 'Superscript':
      return encodeMark(node as stencila.Superscript, state, 'sup')
    case 'Subscript':
      return encodeMark(node as stencila.Subscript, state, 'sub')
    case 'MathFragment':
    case 'MathBlock':
      return encodeMath(node as stencila.Math)
    case 'Figure':
      return encodeFigure(node as stencila.Figure, state)
    case 'ImageObject': {
      const im = node as stencila.ImageObject
      return encodeMedia(im, im.meta?.inline ? 'inline-graphic' : 'graphic')
    }
    case 'MediaObject':
      return encodeMedia(node as stencila.ImageObject, 'media')
    case 'CiteGroup':
      return encodeCiteGroup(node as stencila.CiteGroup, state)
    case 'Cite':
      return encodeCite(node as stencila.Cite, state)
    case 'Collection': {
      const collection = node as stencila.Collection
      if (collection.meta && collection.meta.usage === 'figGroup') {
        return encodeFigGroup(collection, state)
      }
      break
    }

    case 'Null':
    case 'Boolean':
    case 'Number':
    case 'Array':
    case 'Object':
      return [{ type: 'text', text: JSON.stringify(node) }]
    case 'String':
      return [{ type: 'text', text: node as string }]
  }

  log.warn(
    `Unhandled node type when encoding to JATS: "${stencila.nodeType(node)}"`
  )
  return []
}

/**
 * The default decoding function for JATS elements.
 * Decodes the child elements to an array of Stencila `Node`s
 */
function decodeDefault(elem: xml.Element, state: DecodeState): stencila.Node[] {
  return elem.elements !== undefined ? decodeElements(elem.elements, state) : []
}

/**
 * The default encoding function for an array of Stencila nodes.
 */
function encodeDefault(
  name: string,
  nodes: stencila.Node[],
  state: EncodeState
): xml.Element {
  return elem(name, ...encodeNodes(nodes, state))
}

/**
 * Decode an array of JATS elements to an array of Stencila nodes.
 */
function decodeElements(
  elems: xml.Element[],
  state: DecodeState
): stencila.Node[] {
  return elems
    .map((child) => decodeElement(child, state))
    .reduce((prev, curr) => [...prev, ...curr], [])
}

/**
 * Encode an array of Stencila nodes to an array of JATS elements.
 */
function encodeNodes(
  nodes: stencila.Node | stencila.Node[],
  state: EncodeState = initialEncodeState()
): xml.Element[] {
  if (!Array.isArray(nodes)) nodes = [nodes]
  return nodes
    .map((node: stencila.Node) => encodeNode(node, state))
    .reduce(
      (prev: xml.Element[], curr: xml.Element[]) => [...prev, ...curr],
      []
    )
}

/**
 * Decode and array of JATS elements, ensuring the returned
 * results are only `InlineContent` nodes.
 */
function decodeInlineContent(
  elems: xml.Element[],
  state: DecodeState
): stencila.InlineContent[] {
  return ensureInlineContentArray(decodeElements(elems, state))
}

/**
 * Decode a JATS `<alternatives>` element.
 *
 * As per https://jats.nlm.nih.gov/publishing/tag-library/1.2/element/alternatives.html:
 *
 * > Container element used to hold a group of processing alternatives, for example, a
 * single <graphic> that ships in several formats (tif, gif, and jpeg) or in different
 * resolutions. This element is a physical grouping to contain multiple logically
 * equivalent (substitutable) versions of the same information object. Typically these
 * are processing alternatives, and **the reader is expected to see only one version** of
 * the object.
 *
 * Given that the reader is only expected to see one alternative and given that we don't
 * yet have the concept of alternatives in Stencila, we simply take the first one.
 */
function decodeAlternatives(
  elem: xml.Element,
  state: DecodeState
): stencila.Node[] {
  return elem.elements?.[0] ? decodeElement(elem.elements[0], state) : []
}

/**
 * Decode a JATS `<section>` element.
 *
 * This increments the `sectionId` and `sectionDepth` state variables
 * so that they can be applied to heading nodes (decoded from `<title>` elements).
 * It is necessary to retain `id` attributes so that any internal links are maintained.
 */
function decodeSection(elem: xml.Element, state: DecodeState): stencila.Node[] {
  const sectionId = attr(elem, 'id') ?? ''
  const { sectionDepth, ...rest } = state
  return decodeDefault(elem, {
    ...rest,
    ancestorElem: elem,
    sectionId,
    sectionDepth: sectionDepth + 1,
  })
}

/**
 * Decode a JATS section `<title>` to a Stencila `Heading`.
 *
 * Use `sectionId` and `sectionDepth` if a `<sec>` is the closest ancestor.
 * Otherwise (e.g. a figure or table title), use `sectionDepth + 1`, which
 * implies a nested section. This is more likely to ensure conformance with
 * the following rule if the document is encoded to HTML:
 * https://dequeuniversity.com/rules/axe/3.5/heading-order
 */
function decodeHeading(
  elem: xml.Element,
  state: DecodeState
): [stencila.Heading] {
  const { ancestorElem, sectionDepth, sectionId } = state
  const [depth, id] =
    ancestorElem.name === 'sec'
      ? [sectionDepth, sectionId]
      : [sectionDepth + 1, undefined]
  return [
    stencila.heading({
      content: decodeInlineContent(elem.elements ?? [], state),
      depth,
      id,
    }),
  ]
}

/**
 * Encode a Stencila `Heading` to a JATS section `<title>`.
 */
function encodeHeading(
  node: stencila.Heading,
  state: EncodeState
): [xml.Element] {
  return [encodeDefault('title', node.content, state)]
}

/**
 * Decode a JATS `<p>` element to an array of Stencila nodes.
 *
 * This function handles the 'breaking apart' of a paragraph
 * when an element inside it is decoded to a `BlockContent` node
 * rather than an `InlineContent` node.
 */
function decodeParagraph(
  elem: xml.Element,
  state: DecodeState
): stencila.Node[] {
  const id = attrOrUndefined(elem, 'id')
  const nodes = decodeElements(elem.elements ?? [], state)

  let para: stencila.Paragraph | undefined = stencila.paragraph({
    id,
    content: [],
  })

  const blocks: stencila.Node[] = []
  for (const node of nodes) {
    if (stencila.isInlineContent(node)) {
      if (para === undefined) para = stencila.paragraph({ content: [node] })
      else para.content.push(node)
    } else {
      if (para !== undefined) {
        blocks.push(para)
        para = undefined
      }
      blocks.push(node)
    }
  }
  if (para !== undefined) blocks.push(para)

  return blocks
}

/**
 * Encode a Stencila `Paragraph` node as a JATS `<p>` element.
 */
function encodeParagraph(
  node: stencila.Paragraph,
  state: EncodeState
): [xml.Element] {
  return [encodeDefault('p', node.content, state)]
}

/**
 * Decode JATS `<ext-link>` element to a Stencila `Link`.
 */
function decodeExtLink(elem: xml.Element, state: DecodeState): [stencila.Link] {
  return [
    stencila.link({
      content: decodeInlineContent(elem.elements ?? [], state),
      target: attr(elem, 'xlink:href') ?? '',
    }),
  ]
}

/**
 * Encode a Stencila `Link` node as a JATS `<ext-link>` element.
 */
function encodeLink(node: stencila.Link, state: EncodeState): [xml.Element] {
  return [
    elem(
      'ext-link',
      {
        'ext-link-type': 'uri',
        'xlink:href': node.target,
      },
      ...encodeNodes(node.content, state)
    ),
  ]
}

/**
 * Decode a JATS `<xref>` element to a Stencila `Link`, or `Cite` node
 * (depending on its use).
 *
 * The `rid` attribute is decoded to a local `Link`.
 * The `ref-type` attribute is preserved in the link's `relation` property, or
 * discarded if decoding to a `Cite` (in the case of "bibr").
 * See https://jats.nlm.nih.gov/archiving/tag-library/1.1/element/xref.html
 */
function decodeXRef(
  elem: xml.Element,
  state: DecodeState
): [stencila.Link | stencila.Cite] {
  return attr(elem, 'ref-type') === 'bibr'
    ? decodeBibr(elem, state)
    : decodeLink(elem, state)
}

/**
 * Decode a JATS internal identifier.
 *
 * This function normalizes an id so that it can not be confused with a URL.
 * This is necessary for issues such as [this](https://github.com/stencila/encoda/pull/399#issuecomment-580391161)
 * where a `rid` "looked like" a URL and so was treated as such.
 * The [`rid` (reference to an identifer)](https://jats.nlm.nih.gov/archiving/tag-library/1.1/attribute/rid.html)
 * attribute is intended to be used for internal identifiers within the document.
 */
function decodeInternalId(id: string | null): string | undefined {
  if (id === null) return undefined
  return id.replace(/\./g, '-')
}

/**
 * Decode a JATS `<xref>` element to a Stencila `Link`.
 */
function decodeLink(elem: xml.Element, state: DecodeState): [stencila.Link] {
  return [
    stencila.link({
      content: decodeInlineContent(elem.elements ?? [], state),
      target: `#${decodeInternalId(attr(elem, 'rid'))}`,
      relation: attrOrUndefined(elem, 'ref-type'),
    }),
  ]
}

/**
 * Decode a JATS `<xref ref-type="bibr">` element to a Stencila `Cite` node.
 *
 * Decode the content of the citation e.g `Smith et al (1990)` but note that this
 * may be replaced by other content during encoding.
 * Reciprocal function of this is `encodeCite`.
 */
function decodeBibr(elem: xml.Element, state: DecodeState): [stencila.Cite] {
  return [
    stencila.cite({
      content: decodeInlineContent(elem.elements ?? [], state),
      target: decodeInternalId(attr(elem, 'rid')) ?? '',
    }),
  ]
}

/**
 * Encode a Stencila `CiteGroup` node as a JATS `<xref>` elements.
 */
function encodeCiteGroup(
  citeGroup: stencila.CiteGroup,
  state: EncodeState
): xml.Element[] {
  const { items } = citeGroup
  return [
    { type: 'text', text: '(' },
    ...items.reduce((prev: xml.Element[], cite, index) => {
      return [
        ...prev,
        { type: 'text', text: index > 0 ? '; ' : '' },
        ...encodeCite(cite, state, false),
      ]
    }, []),
    { type: 'text', text: ')' },
  ]
}

/**
 * Encode a Stencila `Cite` node as a JATS `<xref>` element.
 */
function encodeCite(
  cite: stencila.Cite,
  state: EncodeState,
  orphan = true
): xml.Element[] {
  const { target: rid, citationMode = 'Parenthetical' } = cite

  const xref = elem('xref', { rid, 'ref-type': 'bibr' })

  if (state.citations[rid] === undefined) state.citations[rid] = []
  state.citations[rid].push(xref)
  populateBibrContent(rid, state)

  return orphan && citationMode === 'Parenthetical'
    ? [{ type: 'text', text: '(' }, xref, { type: 'text', text: ')' }]
    : [xref]
}

/**
 * Check if we have both a reference and its citation, if so, apply the
 * reference content to the citation node
 */
function populateBibrContent(rid: string, state: EncodeState): void {
  if (state.citations[rid] === undefined) return // no elements to populate

  if (state.references[rid] === undefined) return // no refs to use to populate

  state.citations[rid].forEach((xref: xml.Element) => {
    if (xref.elements === undefined) {
      xref.elements = []
    }

    if (xref.elements.length === 0) {
      xref.elements.push({ type: 'text', text: state.references[rid] })
    }
  })
}

/**
 * Deocde a JATS `<italic>`, `<bold>` etc node as a Stencila `Mark` node
 * of `Type` e.g. `Strong`.
 */
function decodeMark(
  elem: xml.Element,
  state: DecodeState,
  type: stencila.Mark['type']
): stencila.Mark[] {
  return [
    {
      type: type,
      content: decodeInlineContent(elem.elements ?? [], state),
    },
  ]
}

/**
 * Encode a Stencila `Mark` node to a JATS element.
 */
function encodeMark(
  node: stencila.Mark,
  state: EncodeState,
  name: string
): [xml.Element] {
  return [elem(name, ...encodeNodes(node.content, state))]
}

/**
 * Deocde a JATS `<list>` element to a Stencila `List` node.
 */
function decodeList(elem: xml.Element, state: DecodeState): [stencila.List] {
  const type = attr(elem, 'list-type')
  const order =
    type === 'bullet' || type === 'simple' ? 'Unordered' : 'Ascending'
  const items = all(elem, 'list-item').map(
    (item): stencila.ListItem => {
      return stencila.listItem({
        content: ensureBlockContentArray(
          decodeElements(item.elements ?? [], state)
        ),
      })
    }
  )
  return [stencila.list({ items, order })]
}

/**
 * Encode a Stencila `List` node as a JATS `<list>` element.
 */
function encodeList(node: stencila.List, state: EncodeState): [xml.Element] {
  const attrs = {
    'list-type': node.order === 'Unordered' ? 'bullet' : 'order',
  }
  const items = node.items.map((item) => {
    const { content = [] } = item
    return elem('list-item', ...encodeNodes(content, state))
  })
  return [elem('list', attrs, ...items)]
}

/**
 * Decode a JATS `<table-wrap>` element to a Stencila `Table` node.
 */
function decodeTableWrap(
  elem: xml.Element,
  state: DecodeState
): [stencila.Table] {
  state = { ...state, ancestorElem: elem }

  const cap = child(elem, 'caption')
  const caption =
    cap !== null && Array.isArray(cap.elements)
      ? ensureBlockContentArray(decodeElements(cap.elements, state))
      : undefined

  const thead = first(elem, 'thead')
  const theadTrs = all(thead, 'tr')
  const headerRows =
    theadTrs.length > 0
      ? theadTrs.map((row) => {
          return stencila.tableRow({
            rowType: 'Header',
            cells: all(row, 'th').map((cell) => {
              const cellAttr = cell?.attributes

              return stencila.tableCell({
                content: decodeInlineContent(cell.elements ?? [], state),
                ...(cellAttr?.colspan &&
                  +cellAttr?.colspan !== 1 && {
                    colspan: +cellAttr.colspan,
                  }),
                ...(cellAttr?.rowspan &&
                  +cellAttr?.rowspan !== 1 && {
                    rowspan: +cellAttr.rowspan,
                  }),
              })
            }),
          })
        })
      : []

  const tbody = first(elem, 'tbody')
  const tbodyTrs = all(tbody, 'tr')
  const bodyRows =
    tbodyTrs.length > 0
      ? tbodyTrs.map((row) => {
          return stencila.tableRow({
            cells: all(row, 'td').map((cell) => {
              const cellAttr = cell?.attributes

              return stencila.tableCell({
                content: decodeInlineContent(cell.elements ?? [], state),
                ...(cellAttr?.colspan &&
                  +cellAttr?.colspan !== 1 && {
                    colspan: +cellAttr.colspan,
                  }),
                ...(cellAttr?.rowspan &&
                  +cellAttr?.rowspan !== 1 && {
                    rowspan: +cellAttr.rowspan,
                  }),
              })
            }),
          })
        })
      : []

  const description = all(elem, 'fn').map((fn) => {
    // Convert each footnote into block content (usually a paragraph),
    // and possibly with an id and footnote type
    const footnoteType = attr(fn, 'fn-type')
    const id = attr(fn, 'id')

    let block: stencila.BlockContent
    const nodes = decodeElements(fn.elements ?? [], state)
    if (nodes.length === 1) {
      // Just one node in footnote (usually a single paragraph),
      // so ensure that it a block and use that.
      block = ensureBlockContent(nodes[0])
    } else {
      // More than one node, perhaps a label and a paragraph
      // so merge them into a single paragraph
      block = stencila.paragraph({
        content: ensureInlineContentArray(nodes),
      })
    }
    // Add id and footnote type to the block
    block = {
      ...block,
      ...(id && { id }),
      ...(footnoteType && { meta: { footnoteType: footnoteType } }),
    }

    return block
  })

  return [
    stencila.table({
      id: decodeInternalId(attr(elem, 'id')),
      label: textOrUndefined(child(elem, 'label')),
      caption,
      rows: [...headerRows, ...bodyRows],
      ...(description.length && { description }),
    }),
  ]
}

/**
 * Encode a Stencila `Table` node as a JATS `<table-wrap>` element.
 */
function encodeTable(table: stencila.Table, state: EncodeState): [xml.Element] {
  state.tables += 1

  const { id, label, caption, rows } = table

  const headerRows = takeLeftWhile(
    (row: stencila.TableRow) => row.rowType === 'Header'
  )(rows)

  const bodyRows = dropLeft(headerRows.length)(rows)

  return [
    elem(
      'table-wrap',
      id ? { id } : {},
      elem('label', label ?? `Table ${state.tables}.`),
      elem('caption', ...(caption ? encodeNodes(caption) : [])),
      elem(
        'table',
        elem(
          'thead',
          ...headerRows.map((row) => {
            return elem(
              'th',
              ...row.cells.map((cell) => {
                return encodeDefault('th', cell.content ?? [], state)
              })
            )
          })
        ),
        elem(
          'tbody',
          ...bodyRows.map((row) => {
            return elem(
              'tr',
              ...row.cells.map((cell) => {
                return encodeDefault('td', cell.content ?? [], state)
              })
            )
          })
        )
      )
    ),
  ]
}

/**
 * Decode a JATS `<fig-group>` element as a Stencila `Collection`.
 */
function decodeFigGroup(
  elem: xml.Element,
  state: DecodeState
): [stencila.Collection] {
  return [
    stencila.collection({
      parts: all(elem, 'fig').map((figEl) => {
        return decodeFigure(figEl, state)[0]
      }),
      meta: { usage: 'figGroup' },
    }),
  ]
}

/**
 * Encode a Stencila `Collection` of `Figure` nodes as a JATS `<fig-group>` element.
 */
function encodeFigGroup(
  figGroup: stencila.Collection,
  state: EncodeState
): [xml.Element] {
  return [
    elem(
      'fig-group',
      ...figGroup.parts
        .filter(stencila.isType('Figure'))
        .map((figure) => encodeFigure(figure, state)[0])
    ),
  ]
}

/**
 * Decode a JATS `<fig>` element to a Stencila `Figure` node.
 */
function decodeFigure(
  elem: xml.Element,
  state: DecodeState
): [stencila.Figure] {
  state = { ...state, ancestorElem: elem }

  const id = decodeInternalId(attr(elem, 'id'))
  const label = textOrUndefined(child(elem, 'label'))
  const licenses = decodeLicenses(elem, state)

  // Get any `caption`
  const captionEl = child(elem, 'caption')
  const caption = captionEl?.elements?.length
    ? ensureBlockContentArray(decodeElements(captionEl.elements, state))
    : undefined

  // Get the `content`, ignoring certain elements that have already been
  // gotten or are not "content". Note that for any `<alternative>` elements
  // that the first child will be taken by `decodeAlternative`.
  const content = []
  if (elem.elements) {
    for (const item of elem.elements) {
      if (
        typeof item.name === 'string' &&
        ![
          'object-id',
          'label',
          'caption',
          'abstract',
          'kwd-group',
          'permissions',
        ].includes(item.name)
      ) {
        content.push(...decodeElement(item, state))
      }
    }
  }

  return [stencila.figure({ id, label, caption, content, licenses })]
}

/**
 * Encode a Stencila `Figure` node as a JATS `<fig>` element.
 *
 * If there are multiple content elements, they will be grouped
 * in an `<alternatives>` element.
 */
function encodeFigure(
  figure: stencila.Figure,
  state: EncodeState
): [xml.Element] {
  const { label, caption, content = [] } = figure
  const children = encodeNodes(content)
  return [
    elem(
      'fig',
      label !== undefined ? elem('label', label) : null,
      caption !== undefined
        ? elem('caption', ...encodeNodes(caption, state))
        : null,
      children.length === 0
        ? null
        : children.length === 1
        ? children[0]
        : elem('alternatives', ...children)
    ),
  ]
}

/**
 * Decode a `<supplementary-material>` element to a `MediaObject` node.
 */
function decodeSupplementaryMaterial(
  elem: xml.Element,
  state: DecodeState
): [stencila.MediaObject] {
  state = { ...state, ancestorElem: elem }

  const id = decodeInternalId(attr(elem, 'id'))
  const text = textOrUndefined(child(elem, 'label'))

  const media = child(elem, 'media')
  const contentUrl =
    (media ? attr(media, 'xlink:href') : attr(elem, 'xlink:href')) ?? ''

  const captionElem = child(elem, 'caption')
  const content = captionElem?.elements?.length
    ? decodeElements(captionElem.elements, state)
    : undefined
  return [
    stencila.mediaObject({
      id,
      contentUrl,
      content,
      text,
    }),
  ]
}

/**
 * Decode a JATS `<inline-formula>` or `<disp-formula>` element to a
 * Stencila `MathFragment`, `MathBlock` or `ImageObject` node.
 *
 * This function preferentially uses `<mml:math>` or `<m:math>` but, if
 * that is not available, uses an image as an alternative (which is wrapped
 * in a paragraph for display formulas).
 */
function decodeMath(
  formula: xml.Element
): (stencila.Math | stencila.ImageObject | stencila.Paragraph)[] {
  const inline = formula.name === 'inline-formula'
  const mathml = first(formula, 'mml:math') ?? first(formula, 'm:math')

  if (mathml === null) {
    const graphic = first(formula, ['graphic', 'inline-graphic'])
    if (graphic === null) return []
    const image = decodeGraphic(graphic, inline)
    return inline ? image : [stencila.paragraph({ content: image })]
  }

  const id = attrOrUndefined(formula, 'id')
  const label = textOrUndefined(child(formula, 'label'))
  const altText = attrOrUndefined(mathml, 'alttext')
  const meta = altText !== undefined ? { altText } : undefined

  // Wrapper is needed to dump the entire math element
  const text = xml.dump(elem('wrapper', mathml))
  return [
    (inline ? stencila.mathFragment : stencila.mathBlock)({
      id,
      label,
      meta,
      mathLanguage: 'mathml',
      text,
    }),
  ]
}

/**
 * Encode a Stencila `Math` node as a JATS `<inline-formula>` or
 * `<display-formula>` element.
 */
function encodeMath(math: stencila.Math): xml.Element[] {
  const { mathLanguage, text = '' } = math

  let inner: xml.Element | undefined
  if (mathLanguage === 'tex') {
    inner = elem('tex-math', text)
  } else {
    try {
      const root = xml.load(text)
      if (root?.elements?.length) inner = root.elements[0]
    } catch (error) {
      log.error(`Error parsing MathML:\n${error.message}\n${text}`)
    }
  }

  return [
    elem(
      math.type === 'MathFragment' ? 'inline-formula' : 'display-formula',
      inner
    ),
  ]
}

/**
 * Decode a JATS `<break>` element into a space.
 *
 * The `break` element is "An explicit line break in the text."
 * and "Usage is discouraged". Assumed not to imply any semantic meaning
 * and in our test fixtures often seems to be used as a `\n` not a `\s\n`
 * (space plus line break). Thus, this returns an empty array
 */
function decodeBreak(): [] {
  return []
}

/**
 * Get the `mimetype` and `mime-subtype` from an element and return it in a
 * traditional `type/subtype` string.
 */
function extractMimetype(elem: xml.Element): string | undefined {
  const mimetype = attr(elem, 'mimetype') ?? ''
  const mimeSubtype = attr(elem, 'mime-subtype') ?? ''

  if (mimetype === '' && mimeSubtype === '') return undefined

  const joiner = mimetype.length && mimeSubtype.length ? '/' : ''
  return mimetype + joiner + mimeSubtype
}

/**
 * Extract the `mediaType` string from `media`, split it into the attributes that
 * JATS requires, then set them on `attrs`
 */
function applyMimetype(media: stencila.MediaObject, attrs: Attributes): void {
  if (media.mediaType === undefined || media.mediaType.length === 0) {
    return
  }

  const jatsType = splitMimetype(media.mediaType)
  if (jatsType.mimetype) {
    attrs.mimetype = jatsType.mimetype
  }
  if (jatsType.mimeSubtype) {
    attrs['mime-subtype'] = jatsType.mimeSubtype
  }
}

/**
 * Interface to reflect how
 * JATS splits the media type into two sections
 */
interface JatsContentType {
  mimetype?: string
  mimeSubtype?: string
}

/**
 * Split a traditional `type/subtype` MIME string into a `JatsContentType`.
 */
function splitMimetype(mimetype: string): JatsContentType {
  const splitType = mimetype.split('/')

  return {
    mimetype: splitType[0].length ? splitType[0] : undefined,
    mimeSubtype: splitType.length > 1 ? splitType[1] : undefined,
  }
}

/**
 * Decode a `<graphic>` element to an ImageObject. There is no corresponding
 * `encodeGraphic` function, use `encodeMedia` with `'graphic'` argument.
 */
function decodeGraphic(
  elem: xml.Element,
  inline: boolean
): [stencila.ImageObject] {
  const contentUrl = attr(elem, 'xlink:href') ?? ''
  const mediaType = extractMimetype(elem)
  const id = attrOrUndefined(elem, 'id')

  const meta: stencila.ImageObject['meta'] = { inline }
  const linkType = attr(elem, 'xlink:type')
  if (linkType) meta.linkType = linkType
  const usage = attr(elem, 'specific-use')
  if (usage) meta.usage = usage

  return [stencila.imageObject({ contentUrl, mediaType, id, meta })]
}

/**
 * Decode a JATS `<media>` element to a Stencila `MediaObject` node.
 */
function decodeMedia(elem: xml.Element): [stencila.MediaObject] {
  return [
    stencila.mediaObject({
      contentUrl: attr(elem, 'xlink:href') ?? '',
      mediaType: extractMimetype(elem),
    }),
  ]
}

/**
 * Encode a Stencila `MediaObject` as a JATS element e.g. `<graphic>`
 */
function encodeMedia(
  media: stencila.MediaObject,
  elementName: string
): [xml.Element] {
  const attrs: Attributes = {
    'xlink:href': media.contentUrl,
  }

  if (media.meta?.usage) {
    attrs['specific-use'] = media.meta.usage
  }

  if (media.meta?.linkType) {
    attrs['xlink:type'] = media.meta.linkType
  }

  applyMimetype(media, attrs)

  return [elem(elementName, attrs)]
}

/**
 * Decode a JATS `<code>` element as a Stencila `CodeBlock`.
 */
function decodeCode(elem: xml.Element): [stencila.CodeBlock] {
  return [
    stencila.codeBlock({
      text: text(elem),
      programmingLanguage: attr(elem, 'language') ?? undefined,
    }),
  ]
}

/**
 * Decode a JATS `<fn>` element as a Stencila `Note`.
 */
function decodeNote(elem: xml.Element, state: DecodeState): [stencila.Note] {
  const id = attrOrUndefined(elem, 'id')
  return [
    stencila.note({
      id,
      content: ensureBlockContentArray(
        decodeElements(elem.elements ?? [], state)
      ),
      noteType: 'Footnote',
    }),
  ]
}

/**
 * Decode a JATS `<statement>` element as a Stencila `Claim`.
 */
function decodeStatement(
  elem: xml.Element,
  state: DecodeState
): [stencila.Claim] {
  const id = attrOrUndefined(elem, 'id')
  const label = textOrUndefined(child(elem, ['label', 'title']))

  let claimType
  if (label !== undefined) {
    const match = /\b(Statement|Theorem|Lemma|Proof|Postulate|Hypothesis|Proposition|Corollary)\b/i.exec(
      label
    )
    if (match) {
      const type = match[0]
      claimType = (type.charAt(0).toUpperCase() +
        type.slice(1)) as stencila.Claim['claimType']
    }
  }

  const content = []
  let title
  if (elem.elements) {
    for (const item of elem.elements) {
      if (typeof item.name === 'string') {
        if (item.name === 'title') {
          const nodes = ensureInlineContentArray(decodeElement(item, state))
          title = nodes.length === 1 && nodes[0] === 'string' ? nodes[0] : nodes
        } else if (
          !['label', 'title', 'kwd-group', 'attrib', 'permission'].includes(
            item.name
          )
        ) {
          content.push(...decodeElement(item, state))
        }
      }
    }
  }

  return [
    stencila.claim({
      id,
      label,
      title,
      claimType,
      content: ensureBlockContentArray(content),
    }),
  ]
}
