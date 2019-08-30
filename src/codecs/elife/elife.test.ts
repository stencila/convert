import { ElifeCodec } from '.'
import * as vfile from '../../util/vfile'
import { nockRecord, snapshot } from '../../__tests__/helpers'
import { YamlCodec } from '../yaml'

const { decode, sniff, encode } = new ElifeCodec()
const yaml = new YamlCodec()

const elife2yaml = async (article: string) => {
  const done = await nockRecord(`nock-record-${article}.json`)
  const result = vfile.dump(
    await yaml.encode(await decode(await vfile.load(`elife: ${article}`)))
  )
  done()
  return result
}

jest.setTimeout(30 * 1000)

test('sniff', async () => {
  expect(await sniff('elife:45187')).toBe(true)
  expect(await sniff('elife: 45187')).toBe(true)
  expect(await sniff('eLife 45187')).toBe(true)
  expect(await sniff('ELIFE: 45187')).toBe(true)
  expect(await sniff(' eLife :  45187  ')).toBe(true)

  expect(await sniff('https://elifesciences.org/articles/45187')).toBe(true)
  expect(await sniff('http://elifesciences.org/articles/45187')).toBe(true)
  expect(await sniff(' https://elifesciences.org/articles/45187  ')).toBe(true)

  expect(await sniff('e life: 45187')).toBe(false)
  expect(await sniff('https://example.org/articles/45187')).toBe(false)
})

test('decode', async () => {
  expect(await elife2yaml('46793')).toMatchFile(snapshot('46793.yaml'))
  expect(await elife2yaml('45123')).toMatchFile(snapshot('45123.yaml'))
})

test('encode', async () => {
  await expect(encode()).rejects.toThrow(
    /Encoding to an eLife article is not yet implemented/
  )
})