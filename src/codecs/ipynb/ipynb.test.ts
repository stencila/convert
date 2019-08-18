import { toMatchFile } from 'jest-file-snapshot'
import * as vfile from '../../util/vfile'
import { fixture, snapshot } from '../../__tests__/helpers'
import { decodeMultilineString, encodeMultilineString, IpynbCodec } from './'
import { JsonCodec } from '../json'

const ipynb = new IpynbCodec()
const json = new JsonCodec()

const ipynb2json = async (name: string) =>
  vfile.dump(
    await json.encode(await ipynb.decode(await vfile.read(fixture(name))))
  )

const json2ipynb = async (name: string) =>
  vfile.dump(
    await ipynb.encode(await json.decode(await vfile.read(fixture(name))))
  )

test('decode', async () => {
  expect(await ipynb2json('metadata-v4.ipynb')).toMatchFile(
    snapshot('metadata-v4.json')
  )
  expect(await ipynb2json('running-code.ipynb')).toMatchFile(
    snapshot('running-code.json')
  )
  expect(await ipynb2json('sunspots.ipynb')).toMatchFile(
    snapshot('sunspots.json')
  )
  expect(await ipynb2json('well-switching.ipynb')).toMatchFile(
    snapshot('well-switching.json')
  )
})

test('encode', async () => {
  expect(await json2ipynb('kitchen-sink.json')).toMatchFile(
    snapshot('kitchen-sink.ipynb')
  )
})

test('encode+decode MultilineString', () => {
  const mls1 = ['Line1\n', 'Line2']
  const mls2 = 'Line1\nLine2'
  const str1 = 'Line1\nLine2'

  expect(decodeMultilineString(mls1)).toEqual(str1)
  expect(decodeMultilineString(mls2)).toEqual(str1)
  expect(encodeMultilineString(str1)).toEqual(mls1)
})
