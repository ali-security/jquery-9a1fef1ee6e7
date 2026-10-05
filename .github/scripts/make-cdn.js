/*
 * Generate dist/cdn/ exactly as build/release.js makeReleaseCopies() does,
 * without needing jquery-release / shelljs. Node 0.10 compatible (ES5).
 *
 * Usage (after grunt has built dist/): node .github/scripts/make-cdn.js
 */
"use strict";

var fs = require( "fs" ),
	path = require( "path" ),

	root = path.join( __dirname, "..", ".." ),
	version = require( path.join( root, "package.json" ) ).version,
	preRelease = /-/.test( version ),

	devFile = "dist/jquery.js",
	minFile = "dist/jquery.min.js",
	mapFile = "dist/jquery.min.map",

	cdnFolder = "dist/cdn",

	mapPattern = /"file":"([^"]+)","sources":\["([^"]+)"\]/,

	releaseFiles = {
		"jquery-VER.js": devFile,
		"jquery-VER.min.js": minFile,
		"jquery-VER.min.map": mapFile,
		"jquery.js": devFile,
		"jquery.min.js": minFile,
		"jquery.min.map": mapFile,
		"jquery-latest.js": devFile,
		"jquery-latest.min.js": minFile,
		"jquery-latest.min.map": mapFile
	};

function abs( file ) {
	return path.join( root, file );
}

function mkdirp( dir ) {
	if ( !fs.existsSync( dir ) ) {
		mkdirp( path.dirname( dir ) );
		fs.mkdirSync( dir );
	}
}

mkdirp( abs( cdnFolder ) );

Object.keys( releaseFiles ).forEach(function( key ) {
	var text,
		before,
		builtFile = releaseFiles[ key ],
		unpathedFile = key.replace( /VER/g, version ),
		releaseFile = cdnFolder + "/" + unpathedFile;

	// Beta releases don't update the jquery-latest etc. copies
	if ( preRelease && key.indexOf( "VER" ) < 0 ) {
		return;
	}

	if ( /\.map$/.test( releaseFile ) ) {
		// Map files need to reference the new uncompressed name;
		// assume that all files reside in the same directory.
		// "file":"jquery.min.js","sources":["jquery.js"]
		before = fs.readFileSync( abs( builtFile ), "utf8" );
		if ( !mapPattern.test( before ) ) {
			throw new Error( "make-cdn: file/sources pattern not found in " + builtFile );
		}
		text = before.replace( mapPattern,
			"\"file\":\"" + unpathedFile.replace( /\.min\.map/, ".min.js" ) +
			"\",\"sources\":[\"" + unpathedFile.replace( /\.min\.map/, ".js" ) + "\"]" );
		fs.writeFileSync( abs( releaseFile ), text );
	} else if ( /\.min\.js$/.test( releaseFile ) ) {
		// Remove the source map comment; it causes way too many problems.
		// Keep the map file in case DevTools allow manual association.
		text = fs.readFileSync( abs( builtFile ), "utf8" )
			.replace( /\/\/# sourceMappingURL=\S+/, "" );
		fs.writeFileSync( abs( releaseFile ), text );
	} else if ( builtFile !== releaseFile ) {
		// Byte-for-byte copy (shell.cp -f)
		fs.writeFileSync( abs( releaseFile ), fs.readFileSync( abs( builtFile ) ) );
	}
	console.log( "make-cdn: " + builtFile + " -> " + releaseFile );
});
