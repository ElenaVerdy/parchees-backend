module.exports = {
    'env': {
        'node': true,
        'commonjs': true
    },
    'extends': [
        'eslint:recommended'
    ],
    'parserOptions': {
        'ecmaFeatures': {
            'jsx': true
        },
        'ecmaVersion': 13
    },
    'rules': {
        'indent': [
            'error',
            4
        ],
        'quotes': [
            'error',
            'single'
        ],
        'semi': [
            'error',
            'never'
        ],
        'no-case-declarations': ['off'],
        'object-curly-spacing': ['error', 'always'],
        'curly': ['error'],
        'no-trailing-spaces': ['error'],
        'brace-style': ['error'],
        'prefer-const': ['error'],
        'newline-after-var': ['error']
    }
}
