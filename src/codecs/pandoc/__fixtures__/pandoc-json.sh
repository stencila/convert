#!/bin/sh

# A little script for generating test fixture in Pandoc JSON
# from files in other formats which are eiseir to author

../../../../vendor/pandoc/bin/pandoc $1 --to json | jq .

