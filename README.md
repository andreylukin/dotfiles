This is my script to get all of my dotfiles in order on a new server.

First, lets add the vimrc

Run this

```echo "runtime vimrc" > ~/.vimrc && mkdir ~/.vim && cd ~/.vim && git clone https://github.com/andreylukin/dotfiles.git . && git clone https://github.com/gmarik/Vundle.vim.git ~/.vim/bundle/Vundle.vim && vim +PluginInstall```


I need to thank **joom/vim-starter** for the idea/code because some/most of it is copied from thier project. :)