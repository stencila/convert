import * as schema from '@stencila/schema'
import { vegaMediaType } from '../../codecs/vega'

export const testData = {
  description: 'A simple bar chart with embedded spec.',
  spec: {
    values: [
      { a: 'A', b: 28 },
      { a: 'B', b: 55 },
      { a: 'C', b: 43 },
      { a: 'D', b: 91 },
      { a: 'E', b: 81 },
      { a: 'F', b: 53 },
      { a: 'G', b: 19 },
      { a: 'H', b: 87 },
      { a: 'I', b: 52 },
    ],
  },
  mark: 'bar',
  encoding: {
    x: { field: 'a', type: 'nominal', axis: { labelAngle: 0 } },
    y: { field: 'b', type: 'quantitative' },
  },
}

export const vegaImage = schema.imageObject({
  contentUrl: 'https://via.placeholder.com/300x150',
  content: [
    {
      mediaType: vegaMediaType,
      spec: testData,
    },
  ],
})
