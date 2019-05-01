import { parse, unparse } from '../src/md'
import { dump, load } from '../src/vfile'

test('parse', async () => {
  expect(await parse(await load(kitchshink.md))).toEqual(kitchshink.node)
  expect(await parse(await load(shorthandYaml.from))).toEqual(
    shorthandYaml.node
  )
})

test('unparse', async () => {
  expect(await dump(await unparse(kitchshink.node))).toEqual(kitchshink.md)
  expect(await dump(await unparse(shorthandYaml.node))).toEqual(
    shorthandYaml.to
  )
})

// An example intended for testing progressively added parser/unparser pairs
const kitchshink = {
  // Note: for bidi conversion, we're using expanded YAML frontmatter,
  // but most authors are likely to prefer using shorter variants e.g.
  //   - Joe James <joe@example.com>
  //   - Dr Jill Jones PhD
  // See other examples for this

  // TODO: use `Article.title` when that is supported (instead of `name`)
  md: `---
name: Our article
authors:
  - type: Person
    givenNames:
      - Joe
    familyNames:
      - James
    emails:
      - joe@example.com
  - type: Person
    honorificPrefix: Dr
    givenNames:
      - Jill
    familyNames:
      - Jones
    honorificSuffix: PhD
---

# Heading one

## Heading two

### Heading three

First paragraph.

A paragraph with _emphasis_, **strong**, ~~delete~~ and \`verbatim\` text.
`,
  node: {
    type: 'Article',
    name: 'Our article',
    authors: [
      {
        type: 'Person',
        givenNames: ['Joe'],
        familyNames: ['James'],
        emails: ['joe@example.com']
      },
      {
        type: 'Person',
        honorificPrefix: 'Dr',
        givenNames: ['Jill'],
        familyNames: ['Jones'],
        honorificSuffix: 'PhD'
      }
    ],
    articleBody: [
      {
        type: 'Heading',
        depth: 1,
        content: ['Heading one']
      },
      {
        type: 'Heading',
        depth: 2,
        content: ['Heading two']
      },
      {
        type: 'Heading',
        depth: 3,
        content: ['Heading three']
      },
      {
        type: 'Paragraph',
        content: ['First paragraph.']
      },
      {
        type: 'Paragraph',
        content: [
          'A paragraph with ',
          {
            type: 'Emphasis',
            content: ['emphasis']
          },
          ', ',
          {
            type: 'Strong',
            content: ['strong']
          },
          ', ',
          {
            type: 'Delete',
            content: ['delete']
          },
          ' and ',
          {
            type: 'Verbatim',
            value: 'verbatim'
          },
          ' text.'
        ]
      }
    ]
  }
}

// Example for testing shorthand YAML
const shorthandYaml = {
  from: `---
authors:
  - Joe James <joe@example.com>
  - Dr Jill Jones PhD
---
`,
  to: `---
authors:
  - type: Person
    givenNames:
      - Joe
    familyNames:
      - James
    emails:
      - joe@example.com
  - type: Person
    honorificPrefix: Dr
    givenNames:
      - Jill
    familyNames:
      - Jones
    honorificSuffix: PhD
---
`,
  node: {
    type: 'Article',
    authors: [
      {
        type: 'Person',
        givenNames: ['Joe'],
        familyNames: ['James'],
        emails: ['joe@example.com']
      },
      {
        type: 'Person',
        honorificPrefix: 'Dr',
        givenNames: ['Jill'],
        familyNames: ['Jones'],
        honorificSuffix: 'PhD'
      }
    ],
    articleBody: []
  }
}
