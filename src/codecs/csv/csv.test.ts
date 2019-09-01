import { Table } from '@stencila/schema'
import { dump, load } from '../../util/vfile'
import { CSVCodec } from './'

const { decode, encode } = new CSVCodec()

const simple = {
  content: `A,B,C\n1,2,3\n2,5,6\n3,8,9\n`,
  node: {
    type: 'Datatable',
    name: 'Sheet1',
    columns: [
      {
        type: 'DatatableColumn',
        name: 'A',
        values: [1, 2, 3]
      },
      {
        type: 'DatatableColumn',
        name: 'B',
        values: [2, 5, 8]
      },
      {
        type: 'DatatableColumn',
        name: 'C',
        values: [3, 6, 9]
      }
    ]
  }
}

const named = {
  content: `code,height,width\na,2,3\nb,5,6\nc,8,9\n`,
  node: {
    type: 'Datatable',
    name: 'Sheet1',
    columns: [
      {
        type: 'DatatableColumn',
        name: 'code',
        values: ['a', 'b', 'c']
      },
      {
        type: 'DatatableColumn',
        name: 'height',
        values: [2, 5, 8]
      },
      {
        type: 'DatatableColumn',
        name: 'width',
        values: [3, 6, 9]
      }
    ]
  }
}

const formulas: { content: string; node: Table } = {
  content: `1,=A1*2\n=B1*3,\n`,
  node: {
    type: 'Table',
    name: 'Sheet1',
    rows: [
      {
        type: 'TableRow',
        cells: [
          {
            type: 'TableCell',
            name: 'A1',
            content: [1]
          },
          {
            type: 'TableCell',
            name: 'B1',
            content: [
              {
                type: 'CodeExpression',
                language: 'excel',
                text: 'A1*2'
              }
            ]
          }
        ]
      },
      {
        type: 'TableRow',
        cells: [
          {
            type: 'TableCell',
            name: 'A2',
            content: [
              {
                type: 'CodeExpression',
                language: 'excel',
                text: 'B1*3'
              }
            ]
          }
        ]
      }
    ]
  }
}

test('decode', async () => {
  expect(await decode(load(simple.content))).toEqual(simple.node)
  expect(await decode(load(named.content))).toEqual(named.node)
})

describe('encode', () => {
  test('simple', async () => {
    expect(await dump(await encode(simple.node))).toEqual(simple.content)
  })

  test('named', async () => {
    expect(await dump(await encode(named.node))).toEqual(named.content)
  })

  test('formulas', async () => {
    expect(await dump(await encode(formulas.node))).toEqual(formulas.content)
  })
})
