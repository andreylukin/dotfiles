"###############
"#Plugins start#
"###############
call plug#begin('~/.vim/plugged')

Plug 'vim-airline/vim-airline'
Plug 'vim-airline/vim-airline-themes'
Plug 'kristijanhusak/vim-hybrid-material'
Plug 'kien/rainbow_parentheses.vim'
Plug 'airblade/vim-gitgutter'
Plug 'airblade/vim-gitgutter'
Plug 'tpope/vim-fugitive'
Plug 'valloric/youcompleteme'
Plug 'easymotion/vim-easymotion'

call plug#end()

"###############
"# Plugins end #
"###############

"Neadwerx vimrc

"####################
"# Nead Werx stolen #
"####################

" Persistant undo
if exists("+undofile")
  " undofile - This allows you to use undos after exiting and restarting
  " This, like swap and backups, uses .vim-undo first, then ~/.vim/undo
  " :help undo-persistence
  " This is only present in 7.3+
  if isdirectory(expand('~/.vim/undo/')) == 0
    exec 'silent !mkdir -p ~/.vim/undo/ > /dev/null 2>&1'
  endif
  set undodir=~/.vim/undo/
  set undofile
endif

" Nead Werx General
set ts=4                           " tab spacing is 4 spaces
set sw=4                           " shift width is 4 spaces
set expandtab                      " expand all tabs to spaces
set ai                             " autoindent a file based on filetype
set si                             " smartindent while typing
set background=dark                " our backdrop is dark
set ruler                          " show row,col count on bottom bar
set backspace=eol,start,indent     " backspace wraps around indents, start of lines, and end of lines
set ignorecase                     " ignore case when searching
set smartcase                      " ...unless we have at least 1 capital letter
set incsearch                      " search incrementally
set formatoptions=tcqronj          " see :help fo-table for more information
set pastetoggle=<F12>              " sets <F12> to toggle paste mode
set hlsearch                       " highlight search results
set wrap                           " wrap lines
set scrolloff=10                   " leave at least 10 lines at the bottom/top of screen when scrolli    ng
set sidescrolloff=15               " leave at least 15 lines at the right/left of screen when scrolli    ng
set sidescroll=1                   " scroll sidways 1 character at a time
set lazyredraw                     " redraw the screen lazily

" turn on syntax coloring and indentation based on the filetype
syntax on
filetype on
filetype indent on



"####################
"# Nead Werx stolen #
"####################

"Themes

set background=dark
colorscheme hybrid_material

"Airline configs

let g:airline_theme = "hybrid"
set laststatus=2

"Rainbow Parenthesis

let g:rbpt_colorpairs = [
    \ ['brown',       'RoyalBlue3'],
    \ ['Darkblue',    'SeaGreen3'],
    \ ['darkgray',    'DarkOrchid3'],
    \ ['darkgreen',   'firebrick3'],
    \ ['darkcyan',    'RoyalBlue3'],
    \ ['darkred',     'SeaGreen3'],
    \ ['darkmagenta', 'DarkOrchid3'],
    \ ['brown',       'firebrick3'],
    \ ['gray',        'RoyalBlue3'],
    \ ['black',       'SeaGreen3'],
    \ ['darkmagenta', 'DarkOrchid3'],
    \ ['Darkblue',    'firebrick3'],
    \ ['darkgreen',   'RoyalBlue3'],
    \ ['darkcyan',    'SeaGreen3'],
    \ ['darkred',     'DarkOrchid3'],
    \ ['red',         'firebrick3'],
    \ ]

let g:rbpt_max = 16
let g:rbpt_loadcmd_toggle = 0
au VimEnter * RainbowParenthesesToggle
au Syntax * RainbowParenthesesLoadRound
au Syntax * RainbowParenthesesLoadSquare
au Syntax * RainbowParenthesesLoadBraces

" Git Gutter

let g:gitgutter_enabled = 1
let g:gitgutter_eager = 1

" YouCompleteMe
if !exists('g:ycm_semantic_triggers')
      let g:ycm_semantic_triggers = {}
  endif
  let g:ycm_semantic_triggers.tex = [
        \ 're!\\[A-Za-z]*(ref|cite)[A-Za-z]*([^]]*])?{([^}]*, ?)*'
        \ ]


"###########
"# General #
"###########

set relativenumber
set number

"Faster scrolling
nmap <C-Up> 3k
nmap <C-Down> 3j
nmap <C-Left> 3h
nmap <C-Right> 3l

"###########
"# General #
"###########
