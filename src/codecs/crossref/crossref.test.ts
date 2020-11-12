import * as schema from '@stencila/schema'
import { CrossrefCodec } from '.'
import * as vfile from '../../util/vfile'
import { nockRecord, snapshot } from '../../__tests__/helpers'
import { YamlCodec } from '../yaml'
import * as elife50356 from '../../__fixtures__/article/journal/elife/50356.json'

// Mocks to avoid changes in ids and timestamps between test runs
jest.mock('crypto')
Date.now = jest.fn(() => 1605068020541)

const crossref = new CrossrefCodec()
const yaml = new YamlCodec()

const query2yaml = async (query: string) =>
  vfile.dump(await yaml.encode(await crossref.decode(await vfile.load(query))))

test.skip('decode', async () => {
  const done = await nockRecord('carlsson-and-ekre-2019.json')
  expect(
    await query2yaml('Carlsson and Ekre, Tensor Computations in Julia')
  ).toMatchFile(snapshot('carlsson-and-ekre-2019.yaml'))
  done()
})

describe('encode', () => {
  test('eLife article', async () => {
    expect(await crossref.dump(elife50356)).toMatchFile(
      snapshot('article-elife-50356.xml')
    )
  })

  test('review of eLife article', async () => {
    const review = {
      type: 'Review',
      authors: [
        schema.person({
          givenNames: ['Jane'],
          familyNames: ['Jones'],
        }),
      ],
      itemReviewed: elife50356,
    }
    expect(await crossref.dump(review)).toMatchFile(
      snapshot('review-elife-50356.xml')
    )
  })
})
