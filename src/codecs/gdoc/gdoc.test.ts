import * as stencila from '@stencila/schema'
import { GDocCodec } from '.'
import { fixture, snapshot } from '../../__tests__/helpers'
import { YamlCodec } from '../yaml'
import * as kitchenSink from './__fixtures__/kitchenSink'
import * as nestedList from './__fixtures__/nestedList'

const gdocCodec = new GDocCodec()
const yamlCodec = new YamlCodec()

describe('decode', () => {
  const gdoc2node = async (gdoc: any) =>
    await gdocCodec.load(JSON.stringify(gdoc), { fetch: false })

  test('title: use the title string property', async () => {
    expect(
      await gdoc2node({
        title: 'The title',
      })
    ).toEqual(stencila.article({ title: 'The title' }))
  })

  test('title: override with a TITLE styled paragraph', async () => {
    expect(
      await gdoc2node({
        title: 'A title',
        body: {
          content: [
            {
              paragraph: {
                elements: [{ textRun: { content: 'The actual title!' } }],
                paragraphStyle: { namedStyleType: 'TITLE' },
              },
            },
          ],
        },
      })
    ).toEqual(
      stencila.article({
        title: 'The actual title!',
      })
    )
  })

  test('title: is not set if neither present', async () => {
    expect(await gdoc2node({})).toEqual(stencila.article({}))
  })

  test('kitchenSink', async () =>
    expect(await gdoc2node(kitchenSink.gdoc)).toEqual(kitchenSink.node))

  test('nestedList', async () =>
    expect(await gdoc2node(nestedList.gdoc)).toEqual(nestedList.node))

  const gdoc2yaml = async (path: string) =>
    yamlCodec.dump(await gdocCodec.read(path))

  test('test-fixture-1.gdoc', async () =>
    expect(await gdoc2yaml(fixture('test-fixture-1.gdoc'))).toMatchFile(
      snapshot('test-fixture-1.yaml')
    ))
})

describe('encode', () => {
  const node2gdoc = async (node: any) => JSON.parse(await gdocCodec.dump(node))

  test('kitchenSink', async () =>
    expect(await node2gdoc(kitchenSink.node)).toEqual(kitchenSink.gdoc))
})
