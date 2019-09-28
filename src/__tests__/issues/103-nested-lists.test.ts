import stencila from '@stencila/schema'
import path from 'path'
import { read } from '../..'
import { DocxCodec } from '../../codecs/docx'
import { GDocCodec } from '../../codecs/gdoc'
import { XmdCodec } from '../../codecs/xmd'

const docxCodec = new DocxCodec()
const gdocCodec = new GDocCodec()
const mdCodec = new XmdCodec()

const article: stencila.Article = {
  type: 'Article',
  title: 'Untitled',
  authors: [],
  content: [
    {
      type: 'List',
      order: 'ascending',
      items: [
        {
          type: 'ListItem',
          content: [
            { type: 'Paragraph', content: ['Fruit'] },
            {
              type: 'List',
              order: 'unordered',
              items: [
                {
                  type: 'ListItem',
                  content: [{ type: 'Paragraph', content: ['Apple'] }]
                },
                {
                  type: 'ListItem',
                  content: [{ type: 'Paragraph', content: ['Orange'] }]
                },
                {
                  type: 'ListItem',
                  content: [{ type: 'Paragraph', content: ['Banana'] }]
                }
              ]
            }
          ]
        },
        {
          type: 'ListItem',
          content: [
            { type: 'Paragraph', content: ['Dairy'] },
            {
              type: 'List',
              order: 'unordered',
              items: [
                {
                  type: 'ListItem',
                  content: [{ type: 'Paragraph', content: ['Milk'] }]
                },
                {
                  type: 'ListItem',
                  content: [{ type: 'Paragraph', content: ['Cheese'] }]
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}

describe('Markdown', () => {
  test('Markdown to Stencila Node', async () => {
    const md = (await read(
      path.join(__dirname, '103-nested-lists.md')
    )) as stencila.Article
    expect(md.content).toEqual(article.content)
  })

  test('Stencila Node to Markdown', async () => {
    const md = (await read(
      path.join(__dirname, '103-nested-lists.md')
    )) as stencila.Article
    expect(mdCodec).toInvert(md)
  })
})

describe('Docx', () => {
  test('Docx to Stencila Node', async () => {
    const docx = (await read(
      path.join(__dirname, '103-nested-lists.docx')
    )) as stencila.Article

    expect(docx.content).toEqual(article.content)
  })

  test('Stencila Node to Docx', async () => {
    const docx = (await read(
      path.join(__dirname, '103-nested-lists.docx')
    )) as stencila.Article
    expect(docxCodec).toInvert(docx)
  })
})

describe('GDoc', () => {
  // GDoc publically shared at:
  //   https://docs.google.com/document/d/1SzJJ1SXHH5g1zjv8IUc3r67vUl8pFSvuU1fAAl3DyZo/edit?usp=sharing
  // and fetched locally using:
  //   node gapis.js docs get 1SzJJ1SXHH5g1zjv8IUc3r67vUl8pFSvuU1fAAl3DyZo 103-nested-lists.gdoc raw

  test('Gdoc to Stencila Node', async () => {
    const gdoc = (await read(
      path.join(__dirname, '103-nested-lists.gdoc')
    )) as stencila.Article
    expect(gdoc.content).toEqual(article.content)
  })

  test.skip('Stencila Node to Gdoc', async () => {
    const gdocArticle = (await read(
      path.join(__dirname, '103-nested-lists.gdoc')
    )) as stencila.Article
    expect(gdocCodec).toInvert(gdocArticle)
  })
})
