import test from 'tape'

import SheetDSVConverter from '../../src/sheet/SheetDSVConverter'
import MemoryStorer from '../../src/host/MemoryStorer'

test('SheetDSVConverter:match', t => {
  let c = new SheetDSVConverter()
  let storer = new MemoryStorer()

  t.plan(4)
  
  c.match('data.csv', storer).then(result => {
    t.ok(result)
  }, 'a CSV file')

  c.match('data.tsv', storer).then(result => {
    t.ok(result)
  }, 'a TSV file')

  c.match('data.psv', storer).then(result => {
    t.ok(result)
  }, 'a PSV file')

  c.match('data.xlsx', storer).then(result => {
    t.notOk(result)
  }, 'not a DSV file')
})

test('SheetDSVConverter:import', t => {
  let csv = `col1,col2
"a",1
"b",2
"c",3
`
  let xml = `<sheet>
  <fields>
    <field name="col1"/>
    <field name="col2"/>
  </fields>
  <values>
    <row>
      <value>a</value>
      <value>1</value>
    </row>
    <row>
      <value>b</value>
      <value>2</value>
    </row>
    <row>
      <value>c</value>
      <value>3</value>
    </row>
  </values>
</sheet>`.replace(/ {2}|\n/g,'')

  let c = new SheetDSVConverter()
  let storer = new MemoryStorer({ 'data.csv': csv })
  let buffer = new MemoryStorer()

  c.import('data.csv', storer, buffer).then(() => {
    buffer.readFile('sheet.xml').then(data => {
      t.equal(data, xml)
      t.end()
    })
  })
})

test('SheetDSVConverter:export', t => {
  let c = new SheetDSVConverter()
  t.throws(c.export, 'SheetDSVConverter.export() not yet implemented')
  t.end()
})
